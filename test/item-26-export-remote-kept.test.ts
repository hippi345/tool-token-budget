import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { serverOrigin } from "./helpers/uiServer.js";
import { analyzeTools } from "../src/pipeline.js";
import type { Report } from "../src/types.js";

describe("item 26: export allowed when only remote server remains", () => {
  let testDir: string;
  let mcpPath: string;
  let server: ServerInstance;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "item26-"));
    await mkdir(path.join(testDir, ".cursor"), { recursive: true });
    mcpPath = path.join(testDir, ".cursor", "mcp.json");
    const config = {
      mcpServers: {
        local: { command: "node", args: ["local.js"] },
        remote: { url: "https://example.com/mcp" },
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    const report: Report = analyzeTools(
      [{ server: "local", name: "t1", description: "d", inputSchema: { type: "object" } }],
      [{ name: "local", status: "ok" }, { name: "remote", status: "skipped_remote" }]
    );
    server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      originalConfig: config,
      configPath: mcpPath,
      cwd: testDir,
      exportDir: path.join(testDir, "exports"),
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("API export succeeds when policy removes stdio but keeps remote", async () => {
    const base = serverOrigin(server);
    const res = await fetch(`${base}/api/export`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: base,
      },
      body: JSON.stringify({ policy: { keepPerServer: 0 }, clientId: "cursor-project" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.written?.length).toBeGreaterThan(0);
  });
});
