import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { serverOrigin } from "./helpers/uiServer.js";
import { analyzeTools } from "../src/pipeline.js";
import type { Report, ToolMeter } from "../src/types.js";

const SENTINEL_HDR = "SENTINEL_HDR_AUTH_91f3";
const SENTINEL_URL_PASS = "SENTINEL_URL_PASS_leak";
const SENTINEL_URL_TOKEN = "SENTINEL_URL_QUERY_leak";
const SENTINEL_API_KEY = "SENTINEL_API_KEY_query";
const SENTINEL_REMOTE_AUTH = "SENTINEL_REMOTE_AUTH_val";
const SENTINEL_ARG = "SENTINEL_ARG_leak_me";
const SENTINEL_NESTED = "SENTINEL_NESTED_leak_me";
const REMOTE_URL = `https://user:${SENTINEL_URL_PASS}@example.com/mcp?token=${SENTINEL_URL_TOKEN}&api_key=${SENTINEL_API_KEY}`;

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

describe("item 21: export proposed file redacts remote passthrough secrets", () => {
  let testDir: string;
  let mcpPath: string;
  let config: Record<string, unknown>;
  let report: Report;
  let server: ServerInstance;

  const sentinels = [
    SENTINEL_HDR,
    SENTINEL_URL_PASS,
    SENTINEL_URL_TOKEN,
    SENTINEL_API_KEY,
    SENTINEL_REMOTE_AUTH,
    SENTINEL_ARG,
    SENTINEL_NESTED,
  ];

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "item21-"));
    await mkdir(path.join(testDir, ".cursor"), { recursive: true });
    mcpPath = path.join(testDir, ".cursor", "mcp.json");
    config = {
      mcpServers: {
        local: {
          command: "node",
          args: ["local.js"],
          env: { API_KEY: "SENTINEL_LOCAL_ENV_abc" },
        },
        remote: {
          url: REMOTE_URL,
          headers: { Authorization: `Bearer ${SENTINEL_HDR}` },
          auth: { token: SENTINEL_REMOTE_AUTH },
          args: [`--api-key=${SENTINEL_ARG}`],
          options: { nested: { value: SENTINEL_NESTED } },
        },
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    report = analyzeTools(
      [
        { server: "local", name: "t1", description: "d", inputSchema: { type: "object" } },
      ],
      [{ name: "local", status: "ok" }, { name: "remote", status: "skipped_remote" }]
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

  it("export proposed file has zero sentinels; preview apply restores byte-identical config", async () => {
    const base = serverOrigin(server);
    const beforeBytes = await readFile(mcpPath, "utf8");
    const policy = { keepPerServer: 5 };

    const exportRes = await fetch(`${base}/api/export`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: base,
      },
      body: JSON.stringify({ policy, clientId: "cursor-project" }),
    });
    expect(exportRes.status).toBe(200);
    const exportData = await exportRes.json();
    const proposedRel = exportData.written.find((p: string) =>
      p.includes("tool-token-budget-proposed")
    );
    expect(proposedRel).toBeDefined();
    const proposedText = await readFile(path.join(testDir, proposedRel), "utf8");
    for (const s of sentinels) {
      expect(proposedText).not.toContain(s);
    }
    expect(proposedText).not.toContain("SENTINEL_LOCAL_ENV_abc");

    const previewRes = await fetch(`${base}/api/apply/preview`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: base,
      },
      body: JSON.stringify({ policy, clientId: "cursor-project" }),
    });
    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();

    const applyRes = await fetch(`${base}/api/apply`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: base,
      },
      body: JSON.stringify({
        policy,
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
    expect(parsed.mcpServers.remote.url).toBe(REMOTE_URL);
    expect(parsed.mcpServers.remote.headers.Authorization).toBe(`Bearer ${SENTINEL_HDR}`);
    expect(parsed.mcpServers.remote.auth.token).toBe(SENTINEL_REMOTE_AUTH);
    expect(parsed.mcpServers.remote.args[0]).toBe(`--api-key=${SENTINEL_ARG}`);
    expect(parsed.mcpServers.remote.options.nested.value).toBe(SENTINEL_NESTED);
    expect(parsed.mcpServers.local.env.API_KEY).toBe("SENTINEL_LOCAL_ENV_abc");
  });
});

describe("item 21: CLI emit proposed file redaction", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cliPath = path.join(repoRoot, "dist", "cli.js");

  async function runEmit(
    testDir: string,
    mcpPath: string,
    extraArgs: string[] = []
  ): Promise<string> {
    const outDir = path.join(testDir, "emit-out");
    execSync(
      `node "${cliPath}" emit "${mcpPath}" --format both --out "${outDir}" ${extraArgs.join(" ")}`,
      { cwd: repoRoot, encoding: "utf8", stdio: "pipe" }
    );
    return await readFile(path.join(outDir, "mcp.json.tool-token-budget-proposed.json"), "utf8");
  }

  it("default emit redacts remote passthrough (no explicit policy flags)", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "item21-cli-"));
    const mcpPath = path.join(testDir, "mcp.json");
    const config = {
      mcpServers: {
        remote: {
          url: REMOTE_URL,
          headers: { Authorization: `Bearer ${SENTINEL_HDR}` },
          auth: { token: SENTINEL_REMOTE_AUTH },
          args: [`--api-key=${SENTINEL_ARG}`],
          options: { nested: { value: SENTINEL_NESTED } },
        },
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    const toolsPath = path.join(testDir, "tools.json");
    await writeFile(
      toolsPath,
      JSON.stringify({
        servers: [{ name: "remote", status: "skipped_remote" }],
        tools: [],
      }) + "\n"
    );

    const proposedText = await runEmit(testDir, mcpPath, [`--tools-json "${toolsPath}"`]);
    for (const s of [
      SENTINEL_HDR,
      SENTINEL_URL_PASS,
      SENTINEL_URL_TOKEN,
      SENTINEL_API_KEY,
      SENTINEL_REMOTE_AUTH,
      SENTINEL_ARG,
      SENTINEL_NESTED,
    ]) {
      expect(proposedText).not.toContain(s);
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it("emit with explicit policy redacts remote passthrough", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "item21-cli-pol-"));
    const mcpPath = path.join(testDir, "mcp.json");
    const config = {
      mcpServers: {
        local: { command: "node", args: ["x.js"], env: { API_KEY: "SENTINEL_LOCAL_ENV_abc" } },
        remote: { url: REMOTE_URL, headers: { Authorization: `Bearer ${SENTINEL_HDR}` } },
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    const toolsPath = path.join(testDir, "tools.json");
    await writeFile(
      toolsPath,
      JSON.stringify({
        servers: [{ name: "local", status: "ok" }, { name: "remote", status: "skipped_remote" }],
        tools: [
          {
            server: "local",
            name: "t1",
            description: "d",
            inputSchema: { type: "object" },
          },
        ],
      }) + "\n"
    );

    const proposedText = await runEmit(
      testDir,
      mcpPath,
      [`--tools-json "${toolsPath}"`, "--keep-per-server", "0"]
    );
    expect(proposedText).not.toContain(SENTINEL_HDR);
    expect(proposedText).not.toContain(SENTINEL_URL_PASS);
    expect(proposedText).not.toContain("SENTINEL_LOCAL_ENV_abc");
    await rm(testDir, { recursive: true, force: true });
  });
});
