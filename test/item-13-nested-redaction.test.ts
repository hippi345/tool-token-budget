import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { serverOrigin } from "./helpers/uiServer.js";
import { analyzeTools } from "../src/pipeline.js";
import type { Report, ToolMeter } from "../src/types.js";
import { redactSecrets } from "../src/utils/redact.js";

const SENTINEL_NESTED = "SENTINEL_NESTED_leak_me";
const SENTINEL_DEEP = "SENTINEL_DEEP_leak_me";
const SENTINEL_ARG = "SENTINEL_ARG_leak_me";
const SENTINEL_URL_PASS = "SENTINEL_URL_PASS_leak";
const SENTINEL_URL_QUERY = "SENTINEL_URL_QUERY_leak";
const HYBRID_URL = `https://deploy:${SENTINEL_URL_PASS}@example.com/mcp?token=${SENTINEL_URL_QUERY}`;

function meter(server: string, name: string, est: number): ToolMeter {
  return {
    server,
    name,
    estTokens: est,
    breakdown: { name: est / 3, description: est / 3, schema: est / 3 },
    shareOfServer: 0,
    shareOfAll: 0,
  };
}

describe("item 13: nested unknown object redaction and round-trip", () => {
  let testDir: string;
  let mcpPath: string;
  let config: Record<string, unknown>;
  let report: Report;
  let server: ServerInstance;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "item13-"));
    await mkdir(path.join(testDir, ".cursor"), { recursive: true });
    mcpPath = path.join(testDir, ".cursor", "mcp.json");
    config = {
      mcpServers: {
        srv: {
          command: "node",
          args: ["run.js"],
          options: {
            nested: { value: SENTINEL_NESTED },
            metadata: { deep: { x: SENTINEL_DEEP } },
          },
        },
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    const meters = [meter("srv", "only", 15)];
    report = analyzeTools(
      [{ server: "srv", name: "only", description: "d", inputSchema: { type: "object" } }],
      [{ name: "srv", status: "ok" }]
    );

    server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      originalConfig: config,
      configPath: mcpPath,
      cwd: testDir,
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("nested sentinels never appear in proposal, preview, or export outputs", async () => {
    const proposalRes = await fetch(`${serverOrigin(server)}/api/proposal`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ policy: { keepPerServer: 1 } }),
    });
    expect(proposalRes.status).toBe(200);
    const proposalText = await proposalRes.text();
    expect(proposalText).not.toContain(SENTINEL_NESTED);
    expect(proposalText).not.toContain(SENTINEL_DEEP);

    const clientsRes = await fetch(`${serverOrigin(server)}/api/clients`, {
      headers: { "X-Auth-Token": server.token },
    });
    const { clients } = await clientsRes.json();
    const clientId = "cursor-project";

    const previewRes = await fetch(`${serverOrigin(server)}/api/apply/preview`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ policy: { keepPerServer: 1 }, clientId }),
    });
    expect(previewRes.status).toBe(200);
    const previewText = await previewRes.text();
    expect(previewText).not.toContain(SENTINEL_NESTED);
    expect(previewText).not.toContain(SENTINEL_DEEP);

    const exportRoot = path.join(testDir, "exports");
    const exportRes = await fetch(`${serverOrigin(server)}/api/export`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ policy: { keepPerServer: 1 }, clientId }),
    });
    expect(exportRes.status).toBe(200);
    const exportData = await exportRes.json();
    const proposedRel = exportData.written.find((p: string) =>
      p.includes("tool-token-budget-proposed")
    );
    const proposedFull = path.join(testDir, proposedRel);
    const exportProposedText = await readFile(proposedFull, "utf8");
    expect(exportProposedText).not.toContain(SENTINEL_NESTED);
    expect(exportProposedText).not.toContain(SENTINEL_DEEP);
  });

  it("preview-then-apply round trip preserves nested values byte-identical when unchanged", async () => {
    const beforeBytes = await readFile(mcpPath, "utf8");

    const clientsRes = await fetch(`${serverOrigin(server)}/api/clients`, {
      headers: { "X-Auth-Token": server.token },
    });
    const { clients } = await clientsRes.json();
    const clientId = "cursor-project";

    const previewRes = await fetch(`${serverOrigin(server)}/api/apply/preview`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ policy: { keepPerServer: 1 }, clientId }),
    });
    const preview = await previewRes.json();

    const applyRes = await fetch(`${serverOrigin(server)}/api/apply`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: `${serverOrigin(server)}`,
      },
      body: JSON.stringify({
        policy: { keepPerServer: 1 },
        clientId,
        previewHash: preview.currentHash,
        previewToken: preview.previewToken,
        confirmation: "apply",
      }),
    });
    expect(applyRes.status).toBe(200);

    const afterBytes = await readFile(mcpPath, "utf8");
    expect(afterBytes).toBe(beforeBytes);
  });

  it("redactSecrets replaces unknown nested string leaves with placeholders", () => {
    const redacted = redactSecrets(config) as any;
    expect(redacted.mcpServers.srv.options.nested.value).toBe("<from-original>");
    expect(redacted.mcpServers.srv.options.metadata.deep.x).toBe("<from-original>");
  });
});

describe("item 13: hybrid url+stdio server redaction and verbatim round-trip", () => {

  it("hybrid entry: no sentinels in proposal, preview, or export", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "item13-hybrid-"));
    await mkdir(path.join(testDir, ".cursor"), { recursive: true });
    const mcpPath = path.join(testDir, ".cursor", "mcp.json");
    const config = {
      mcpServers: {
        hybrid: {
          url: HYBRID_URL,
          command: "node",
          args: [`--api-key=${SENTINEL_ARG}`, "run.js"],
          options: {
            nested: { value: SENTINEL_NESTED },
            metadata: { deep: { x: SENTINEL_DEEP } },
          },
        },
        plain: { command: "node", args: ["plain.js"] },
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    const report = analyzeTools(
      [
        { server: "hybrid", name: "h1", description: "d", inputSchema: { type: "object" } },
        { server: "plain", name: "p1", description: "d", inputSchema: { type: "object" } },
      ],
      [{ name: "hybrid", status: "ok" }, { name: "plain", status: "ok" }]
    );

    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      originalConfig: config,
      configPath: mcpPath,
      cwd: testDir,
    });

    const sentinels = [SENTINEL_NESTED, SENTINEL_DEEP, SENTINEL_ARG, SENTINEL_URL_PASS, SENTINEL_URL_QUERY];
    const clientId = "cursor-project";
    const base = serverOrigin(server);

    try {
      const proposalRes = await fetch(`${base}/api/proposal`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: base,
        },
        body: JSON.stringify({ policy: { keepPerServer: 2 } }),
      });
      const proposalText = await proposalRes.text();
      expect(proposalRes.status).toBe(200);
      for (const s of sentinels) {
        expect(proposalText).not.toContain(s);
      }

      const previewRes = await fetch(`${base}/api/apply/preview`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: base,
        },
        body: JSON.stringify({ policy: { keepPerServer: 2 }, clientId }),
      });
      const previewText = await previewRes.text();
      expect(previewRes.status).toBe(200);
      for (const s of sentinels) {
        expect(previewText).not.toContain(s);
      }

      const exportRes = await fetch(`${base}/api/export`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: base,
        },
        body: JSON.stringify({ policy: { keepPerServer: 2 }, clientId }),
      });
      expect(exportRes.status).toBe(200);
      const exportData = await exportRes.json();
      const proposedRel = exportData.written.find((p: string) =>
        p.includes("tool-token-budget-proposed")
      );
      const exportText = await readFile(path.join(testDir, proposedRel), "utf8");
      for (const s of sentinels) {
        expect(exportText).not.toContain(s);
      }
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("UI apply keeps hybrid url, args, and options byte-identical when policy makes no file change", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "item13-hybrid-ui-"));
    await mkdir(path.join(testDir, ".cursor"), { recursive: true });
    const mcpPath = path.join(testDir, ".cursor", "mcp.json");
    const config = {
      mcpServers: {
        hybrid: {
          url: HYBRID_URL,
          command: "node",
          args: [`--api-key=${SENTINEL_ARG}`, "run.js"],
          options: {
            nested: { value: SENTINEL_NESTED },
            metadata: { deep: { x: SENTINEL_DEEP } },
          },
        },
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    const beforeBytes = await readFile(mcpPath, "utf8");

    const report = analyzeTools(
      [{ server: "hybrid", name: "h1", description: "d", inputSchema: { type: "object" } }],
      [{ name: "hybrid", status: "ok" }]
    );

    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      originalConfig: config,
      configPath: mcpPath,
      cwd: testDir,
    });

    try {
      const previewRes = await fetch(`${serverOrigin(server)}/api/apply/preview`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: `${serverOrigin(server)}`,
        },
        body: JSON.stringify({ policy: { keepPerServer: 5 }, clientId: "cursor-project" }),
      });
      const preview = await previewRes.json();
      expect(previewRes.status).toBe(200);

      const applyRes = await fetch(`${serverOrigin(server)}/api/apply`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: `${serverOrigin(server)}`,
        },
        body: JSON.stringify({
          policy: { keepPerServer: 5 },
          clientId: "cursor-project",
          previewHash: preview.currentHash,
          previewToken: preview.previewToken,
          confirmation: "apply",
        }),
      });
      expect(applyRes.status).toBe(200);

      const afterBytes = await readFile(mcpPath, "utf8");
      expect(afterBytes).toBe(beforeBytes);
      const parsed = JSON.parse(afterBytes);
      expect(parsed.mcpServers.hybrid.url).toBe(HYBRID_URL);
      expect(parsed.mcpServers.hybrid.args[0]).toBe(`--api-key=${SENTINEL_ARG}`);
      expect(parsed.mcpServers.hybrid.options.nested.value).toBe(SENTINEL_NESTED);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("CLI apply keeps hybrid url, args, and options byte-identical when policy makes no file change", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "item13-hybrid-cli-"));
    const mcpPath = path.join(testDir, "mcp.json");
    const outDir = path.join(testDir, "out");
    const config = {
      mcpServers: {
        hybrid: {
          url: HYBRID_URL,
          command: "node",
          args: [`--api-key=${SENTINEL_ARG}`, "run.js"],
          options: {
            nested: { value: SENTINEL_NESTED },
            metadata: { deep: { x: SENTINEL_DEEP } },
          },
        },
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    const beforeBytes = await readFile(mcpPath, "utf8");

    const report = analyzeTools(
      [{ server: "hybrid", name: "h1", description: "d", inputSchema: { type: "object" } }],
      [{ name: "hybrid", status: "ok" }]
    );
    const { writeArtifacts } = await import("../src/emit/writeArtifacts.js");
    await writeArtifacts(outDir, report, {
      format: "both",
      originalConfig: config,
      mcpConfigPath: mcpPath,
      policy: { keepPerServer: 5 },
    });

    const { applyConfig } = await import("../src/apply/applyConfig.js");
    const result = await applyConfig({
      mcpConfigPath: mcpPath,
      proposedPath: path.join(outDir, "mcp.json.tool-token-budget-proposed.json"),
      dryRun: false,
      backup: true,
      yes: true,
    });
    expect(result.success).toBe(true);

    const afterBytes = await readFile(mcpPath, "utf8");
    expect(afterBytes).toBe(beforeBytes);
    const parsed = JSON.parse(afterBytes);
    expect(parsed.mcpServers.hybrid.url).toBe(HYBRID_URL);
    expect(parsed.mcpServers.hybrid.args[0]).toBe(`--api-key=${SENTINEL_ARG}`);
    expect(parsed.mcpServers.hybrid.options.nested.value).toBe(SENTINEL_NESTED);

    await rm(testDir, { recursive: true, force: true });
  });
});
