import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { serverOrigin } from "./helpers/uiServer.js";
import { analyzeTools } from "../src/pipeline.js";
import type { Report, ToolMeter } from "../src/types.js";
import { applyConfig } from "../src/apply/applyConfig.js";
import { writeArtifacts } from "../src/emit/writeArtifacts.js";

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

describe("item 22: failed discovery servers are never removed by apply", () => {
  let testDir: string;
  let mcpPath: string;
  let config: Record<string, unknown>;
  let report: Report;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "item22-"));
    await mkdir(path.join(testDir, ".cursor"), { recursive: true });
    mcpPath = path.join(testDir, ".cursor", "mcp.json");
    config = {
      mcpServers: {
        filesystem: { command: "node", args: ["fs.js"] },
        healthy: { command: "node", args: ["ok.js"] },
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    report = analyzeTools(
      [{ server: "healthy", name: "t1", description: "d", inputSchema: { type: "object" } }],
      [
        { name: "filesystem", status: "timed_out", error: "timeout" },
        { name: "healthy", status: "ok" },
      ]
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("CLI apply keeps timed_out server in config", async () => {
    const outDir = path.join(testDir, "out");
    await writeArtifacts(outDir, report, {
      format: "both",
      originalConfig: config,
      mcpConfigPath: mcpPath,
      policy: { keepPerServer: 1 },
    });
    const before = await readFile(mcpPath, "utf8");
    const proposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");
    const result = await applyConfig({
      mcpConfigPath: mcpPath,
      proposedPath,
      dryRun: false,
      backup: true,
      yes: true,
    });
    expect(result.success).toBe(true);
    const after = await readFile(mcpPath, "utf8");
    expect(JSON.parse(after).mcpServers.filesystem).toBeDefined();
    const backups = (await readdir(path.dirname(mcpPath))).filter((f) => f.includes(".bak"));
    expect(backups.length).toBe(0);
    expect(after).toBe(before);
  });

  it("UI apply preview keeps timed_out server and apply is no-op", async () => {
    let server: ServerInstance | undefined;
    try {
      server = await startServer({
        port: 0,
        onReady: () => {},
        getReport: () => report,
        originalConfig: config,
        configPath: mcpPath,
        cwd: testDir,
      });
      const base = serverOrigin(server);
      const before = await readFile(mcpPath, "utf8");
      const previewRes = await fetch(`${base}/api/apply/preview`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: base,
        },
        body: JSON.stringify({ policy: { keepPerServer: 1 }, clientId: "cursor-project" }),
      });
      expect(previewRes.status).toBe(200);
      const previewText = await previewRes.text();
      expect(previewText).toContain("filesystem");
      const preview = JSON.parse(previewText);

      const applyRes = await fetch(`${base}/api/apply`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: base,
        },
        body: JSON.stringify({
          policy: { keepPerServer: 1 },
          clientId: "cursor-project",
          previewHash: preview.currentHash,
          previewToken: preview.previewToken,
          confirmation: "apply",
        }),
      });
      expect(applyRes.status).toBe(200);
      const after = await readFile(mcpPath, "utf8");
      expect(after).toBe(before);
    } finally {
      await server?.close();
    }
  });
});
