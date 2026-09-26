import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
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

describe("item 11: UI preview and apply with remote server", () => {
  const remoteEntry = {
    url: "https://remote.example.com/sse",
    headers: { Authorization: "Bearer tok" },
  };

  let testDir: string;
  let mcpPath: string;
  let report: Report;
  let server: ServerInstance;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "item11-"));
    await mkdir(path.join(testDir, ".cursor"), { recursive: true });
    mcpPath = path.join(testDir, ".cursor", "mcp.json");
    const config = {
      mcpServers: {
        local: { command: "node", args: ["x.js"] },
        remote: remoteEntry,
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    const meters = [meter("local", "a", 10), meter("local", "b", 20)];
    report = analyzeTools(
      meters.map((m) => ({
        server: m.server,
        name: m.name,
        description: "d",
        inputSchema: { type: "object" },
      })),
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

  it("preview returns 200 and apply keeps remote server unchanged", async () => {
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
    const preview = await previewRes.json();
    expect(JSON.stringify(preview.proposedConfig)).toContain("remote");

    const before = JSON.parse(await readFile(mcpPath, "utf8"));
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

    const after = JSON.parse(await readFile(mcpPath, "utf8"));
    expect(after.mcpServers.remote).toEqual(before.mcpServers.remote);
  });
});
