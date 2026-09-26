import { describe, it, expect } from "vitest";
import { shouldRetryDiscoveryPost } from "../gui/src/httpErrors.js";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { serverOrigin } from "./helpers/uiServer.js";
import { analyzeTools } from "../src/pipeline.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PolicyOptions, Tool } from "../src/types.js";

async function setupApplyServer() {
  const testDir = await mkdtemp(path.join(os.tmpdir(), "item48-"));
  const cursorDir = path.join(testDir, ".cursor");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cursorDir, { recursive: true });
  const mcpPath = path.join(cursorDir, "mcp.json");
  const mcpServers = {
    big: { command: "node", args: ["b.js"] },
    small: { command: "node", args: ["s.js"] },
  };
  const content = JSON.stringify({ mcpServers }, null, 2) + "\n";
  await writeFile(mcpPath, content, "utf8");
  const tools: Tool[] = ["big", "small"].flatMap((server) => [
    {
      server,
      name: "t1",
      description: "d ".repeat(30),
      inputSchema: { type: "object", properties: { p: { type: "string" } } },
    },
    {
      server,
      name: "t2",
      description: "d ".repeat(30),
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  ]);
  const report = analyzeTools(tools, [
    { name: "big", status: "ok" },
    { name: "small", status: "ok" },
  ]);
  const server = await startServer({
    port: 0,
    onReady: () => {},
    getReport: () => report,
    configPath: mcpPath,
    originalConfig: { mcpServers },
    cwd: testDir,
    initialAnalyzedContent: content,
  });
  return { server, testDir, mcpPath };
}

describe("item 48: apply must not auto-retry or double-apply", () => {
  it("shouldRetryDiscoveryPost is false for /api/apply but true for preview on 503", () => {
    const body = JSON.stringify({ error: "Discovery in progress" });
    expect(shouldRetryDiscoveryPost("/api/apply", 503, body)).toBe(false);
    expect(shouldRetryDiscoveryPost("/api/apply/preview", 503, body)).toBe(true);
  });

  it("rejects a second apply with the same preview hash", async () => {
    const { server, testDir } = await setupApplyServer();
    try {
      const policy: PolicyOptions = { keepPerServer: 1 };
      const origin = serverOrigin(server);
      const previewRes = await fetch(`${origin}/api/apply/preview`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ policy, clientId: "cursor-project" }),
      });
      expect(previewRes.status).toBe(200);
      const previewData = await previewRes.json();
      const body = JSON.stringify({
        policy,
        clientId: "cursor-project",
        previewHash: previewData.currentHash,
        previewToken: previewData.previewToken,
        confirmation: "apply",
      });
      const first = await fetch(`${origin}/api/apply`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: origin,
        },
        body,
      });
      expect(first.status).toBe(200);
      const second = await fetch(`${origin}/api/apply`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: origin,
        },
        body,
      });
      expect(second.status).toBe(409);
      const text = await second.text();
      expect(text).toMatch(/already applied/i);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
