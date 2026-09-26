import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { serverOrigin } from "./helpers/uiServer.js";
import { analyzeTools } from "../src/pipeline.js";
import type { Report } from "../src/types.js";

describe("item 23: discovery gate applies only to initial discovery", () => {
  let testDir: string;
  let mcpPath: string;
  let report: Report;
  let server: ServerInstance;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "item23-"));
    await mkdir(path.join(testDir, ".cursor"), { recursive: true });
    mcpPath = path.join(testDir, ".cursor", "mcp.json");
    const config = {
      mcpServers: {
        filesystem: { command: "node", args: ["fs.js"] },
        other: { command: "node", args: ["other.js"] },
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    report = analyzeTools(
      [{ server: "other", name: "t1", description: "d", inputSchema: { type: "object" } }],
      [
        { name: "filesystem", status: "timed_out" },
        { name: "other", status: "ok" },
      ]
    );
    server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      isDiscoveryInProgress: () => false,
      originalConfig: config,
      configPath: mcpPath,
      cwd: testDir,
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("preview succeeds during refresh-style partial report (gate off)", async () => {
    const base = serverOrigin(server);
    const res = await fetch(`${base}/api/apply/preview`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: base,
      },
      body: JSON.stringify({ policy: { keepPerServer: 1 }, clientId: "cursor-project" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/^\s*\{\s*"error"/);
    expect(text).toContain("filesystem");
  });
});
