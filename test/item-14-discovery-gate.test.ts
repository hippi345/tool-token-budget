import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { serverOrigin } from "./helpers/uiServer.js";
import { analyzeTools } from "../src/pipeline.js";
import type { Report, ToolMeter } from "../src/types.js";

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

describe("item 14: preview gated during discovery", () => {
  let testDir: string;
  let mcpPath: string;
  let server: ServerInstance;
  let discoveryInProgress = false;
  let report: Report;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "item14-"));
    await mkdir(path.join(testDir, ".cursor"), { recursive: true });
    mcpPath = path.join(testDir, ".cursor", "mcp.json");
    const config = {
      mcpServers: {
        filesystem: { command: "node", args: ["fs.js"] },
        other: { command: "node", args: ["other.js"] },
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    // Partial discovery: only "other" metered; filesystem not in report.servers yet
    const meters = [meter("other", "t1", 10)];
    report = analyzeTools(
      meters.map((m) => ({
        server: m.server,
        name: m.name,
        description: "d",
        inputSchema: { type: "object" },
      })),
      [{ name: "other", status: "ok" }]
    );

    server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      isDiscoveryInProgress: () => discoveryInProgress,
      originalConfig: config,
      configPath: mcpPath,
      cwd: testDir,
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("preview returns 503 while discovery in progress, then 200 when settled", async () => {
    const clientsRes = await fetch(`${serverOrigin(server)}/api/clients`, {
      headers: { "X-Auth-Token": server.token },
    });
    const { clients } = await clientsRes.json();
    const clientId = "cursor-project";

    discoveryInProgress = true;
    const busyRes = await fetch(`${serverOrigin(server)}/api/apply/preview`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ policy: { keepPerServer: 1 }, clientId }),
    });
    expect(busyRes.status).toBe(503);
    expect(await busyRes.text()).not.toContain("would unexpectedly remove servers");

    discoveryInProgress = false;
    report = analyzeTools(
      [
        { server: "other", name: "t1", description: "d", inputSchema: { type: "object" } },
        { server: "filesystem", name: "read", description: "d", inputSchema: { type: "object" } },
      ],
      [
        { name: "other", status: "ok" },
        { name: "filesystem", status: "ok" },
      ]
    );

    const okRes = await fetch(`${serverOrigin(server)}/api/apply/preview`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ policy: { keepPerServer: 1 }, clientId }),
    });
    expect(okRes.status).toBe(200);
  });
});
