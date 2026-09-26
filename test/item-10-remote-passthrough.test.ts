import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeArtifacts } from "../src/emit/writeArtifacts.js";
import { analyzeTools } from "../src/pipeline.js";
import type { Report, ToolMeter } from "../src/types.js";
import { toolKey } from "../src/emit/keepHot.js";
import { applyConfig } from "../src/apply/applyConfig.js";
import { buildProposedMcpConfig } from "../src/emit/writeArtifacts.js";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { serverOrigin } from "./helpers/uiServer.js";

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

describe("item 10: remote servers pass through emit, export, and apply guard", () => {
  const remoteEntry = {
    url: "https://user:pass@remote.example.com/mcp?token=sekret",
    headers: { Authorization: "Bearer remote-header" },
    requestHeaders: { "X-Custom": "nested-request" },
  };

  const originalConfig = {
    mcpServers: {
      local: { command: "node", args: ["local.js"], env: { API_KEY: "local-secret" } },
      remote: remoteEntry,
    },
  };

  let testDir: string;
  let mcpPath: string;
  let outDir: string;
  let report: Report;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "item10-"));
    await mkdir(path.join(testDir, ".cursor"), { recursive: true });
    mcpPath = path.join(testDir, ".cursor", "mcp.json");
    outDir = path.join(testDir, "out");
    await writeFile(mcpPath, JSON.stringify(originalConfig, null, 2) + "\n", "utf8");

    const meters = [meter("local", "toolA", 10), meter("local", "toolB", 20)];
    report = analyzeTools(
      meters.map((m) => ({
        server: m.server,
        name: m.name,
        description: "d",
        inputSchema: { type: "object" },
      })),
      [{ name: "local", status: "ok" }, { name: "remote", status: "skipped_remote" }]
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("emit then apply preserves remote server entry deep-equal to original", async () => {
    await writeArtifacts(outDir, report, {
      format: "both",
      originalConfig,
      mcpConfigPath: mcpPath,
      policy: { keepPerServer: 1 },
    });

    const proposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");
    const proposed = JSON.parse(await readFile(proposedPath, "utf8"));
    expect(proposed.mcpServers.remote.url).toBe(
      "https://<from-original>@remote.example.com/mcp?token=<from-original>"
    );
    expect(proposed.mcpServers.remote.headers.Authorization).toBe("<from-original>");
    expect(JSON.stringify(proposed.mcpServers.remote)).not.toContain("sekret");
    expect(JSON.stringify(proposed.mcpServers.remote)).not.toContain("remote-header");

    const applyResult = await applyConfig({
      mcpConfigPath: mcpPath,
      proposedPath,
      dryRun: false,
      backup: true,
      yes: true,
    });
    expect(applyResult.success).toBe(true);

    const after = JSON.parse(await readFile(mcpPath, "utf8"));
    expect(after.mcpServers.remote).toEqual(remoteEntry);
  });

  it("UI export proposed config keeps remote server unchanged", async () => {
    const exportRoot = path.join(testDir, "exports");
    let server: ServerInstance | undefined;
    try {
      server = await startServer({
        port: 0,
        onReady: () => {},
        getReport: () => report,
        originalConfig,
        configPath: mcpPath,
        cwd: testDir,
        exportDir: exportRoot,
      });

      const origin = serverOrigin(server);
      const clientsRes = await fetch(`${origin}/api/clients`, {
        headers: { "X-Auth-Token": server.token },
      });
      const { clients } = await clientsRes.json();
      const clientId = clients.find((c: { id: string }) => c.id === "cursor-project")?.id;
      expect(clientId).toBe("cursor-project");

      const res = await fetch(`${origin}/api/export`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ policy: { keepPerServer: 1 }, clientId }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      const proposedPath = data.written.find((p: string) =>
        p.includes("tool-token-budget-proposed")
      );
      expect(proposedPath).toBeDefined();
      const fullProposed = JSON.parse(await readFile(path.join(testDir, proposedPath), "utf8"));
      expect(fullProposed.mcpServers.remote.url).not.toContain("pass");
      expect(fullProposed.mcpServers.remote.headers.Authorization).toBe("<from-original>");
    } finally {
      await server?.close();
    }
  });

  it("CLI apply guard refuses unexpected remote removal when report is present", async () => {
    await writeArtifacts(outDir, report, {
      format: "both",
      originalConfig,
      mcpConfigPath: mcpPath,
      policy: { keepPerServer: 1 },
    });

    const proposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");
    const badProposed = JSON.parse(await readFile(proposedPath, "utf8"));
    delete badProposed.mcpServers.remote;
    await writeFile(proposedPath, JSON.stringify(badProposed, null, 2) + "\n", "utf8");

    const result = await applyConfig({
      mcpConfigPath: mcpPath,
      proposedPath,
      dryRun: false,
      backup: true,
      yes: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("would unexpectedly remove servers");
    expect(result.error).toContain("remote");

    const unchanged = JSON.parse(await readFile(mcpPath, "utf8"));
    expect(unchanged.mcpServers.remote).toEqual(remoteEntry);
  });

  it("buildProposedMcpConfig keeps remote without counting as removed", () => {
    const hot = new Set([toolKey("local", "toolA")]);
    const { proposed, allRemovedServers } = buildProposedMcpConfig(
      originalConfig,
      hot,
      new Set(),
      report.tools
    );
    expect((proposed as any).mcpServers.remote.url).toContain("<from-original>");
    expect((proposed as any).mcpServers.remote.headers.Authorization).toBe("<from-original>");
    expect(allRemovedServers.has("remote")).toBe(false);
  });
});
