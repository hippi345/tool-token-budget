import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { serverOrigin } from "./helpers/uiServer.js";
import { analyzeTools } from "../src/pipeline.js";
import type { Report } from "../src/types.js";

describe("item 25: oversized request body returns 413", () => {
  let testDir: string;
  let server: ServerInstance;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "item25-"));
    await mkdir(path.join(testDir, ".cursor"), { recursive: true });
    const mcpPath = path.join(testDir, ".cursor", "mcp.json");
    await writeFile(
      mcpPath,
      JSON.stringify({ mcpServers: { a: { command: "node", args: ["x.js"] } } }, null, 2) + "\n"
    );
    const report: Report = analyzeTools(
      [{ server: "a", name: "t1", description: "d", inputSchema: { type: "object" } }],
      [{ name: "a", status: "ok" }]
    );
    server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      configPath: mcpPath,
      cwd: testDir,
      maxRequestBodyBytes: 4096,
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("returns 413 Payload Too Large for bodies over 10MB", async () => {
    const base = serverOrigin(server);
    const huge = "x".repeat(5000);
    const res = await fetch(`${base}/api/proposal`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: base,
      },
      body: JSON.stringify({ policy: { keepPerServer: 2 }, padding: huge }),
    });
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("Payload Too Large");
  });
});
