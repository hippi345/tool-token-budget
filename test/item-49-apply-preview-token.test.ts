import { describe, it, expect } from "vitest";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { apiPost } from "./helpers/uiServer.js";
import { analyzeTools } from "../src/pipeline.js";
import { mkdtemp, readFile, writeFile, rm, copyFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PolicyOptions, Tool } from "../src/types.js";

async function setupServer() {
  const testDir = await mkdtemp(path.join(os.tmpdir(), "item49-"));
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
  return { server, testDir, mcpPath, content };
}

describe("item 49: apply single-use keyed by preview token", () => {
  it("allows a second apply after no-op when file unchanged but preview is fresh", async () => {
    const { server, testDir } = await setupServer();
    try {
      const clientId = "cursor-project";
      const p1 = await apiPost(server, "/api/apply/preview", { policy: {}, clientId });
      expect(p1.status).toBe(200);
      const d1 = await p1.json();
      const a1 = await apiPost(server, "/api/apply", {
        policy: {},
        clientId,
        previewHash: d1.currentHash,
        previewToken: d1.previewToken,
        confirmation: "apply",
      });
      expect(a1.status).toBe(200);

      const p2 = await apiPost(server, "/api/apply/preview", {
        policy: { disableServersOver: 500 },
        clientId,
      });
      expect(p2.status).toBe(200);
      const d2 = await p2.json();
      const a2 = await apiPost(server, "/api/apply", {
        policy: { disableServersOver: 500 },
        clientId,
        previewHash: d2.currentHash,
        previewToken: d2.previewToken,
        confirmation: "apply",
      });
      expect(a2.status).toBe(200);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it("allows apply after restoring original bytes from backup", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item49-bak-"));
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
    ]);
    tools.push({
      server: "big",
      name: "t2",
      description: "x ".repeat(40),
      inputSchema: { type: "object", properties: { a: { type: "string" } } },
    });
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
    try {
      const clientId = "cursor-project";
      const policy: PolicyOptions = { disableServersOver: 50 };
      const p1 = await apiPost(server, "/api/apply/preview", { policy, clientId });
      const d1 = await p1.json();
      const a1 = await apiPost(server, "/api/apply", {
        policy,
        clientId,
        previewHash: d1.currentHash,
        previewToken: d1.previewToken,
        confirmation: "apply",
      });
      expect(a1.status).toBe(200);
      const a1Json = await a1.json();
      expect(a1Json.backupPath).toBeDefined();
      await copyFile(a1Json.backupPath, mcpPath);
      const restoredContent = await readFile(mcpPath, "utf8");
      server.reconcileBaselineAfterPoll(restoredContent, report);

      const p2 = await apiPost(server, "/api/apply/preview", { policy, clientId });
      expect(p2.status).toBe(200);
      const d2 = await p2.json();
      const a2 = await apiPost(server, "/api/apply", {
        policy,
        clientId,
        previewHash: d2.currentHash,
        previewToken: d2.previewToken,
        confirmation: "apply",
      });
      expect(a2.status).toBe(200);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it("rejects reusing the same preview token twice", async () => {
    const { server, testDir } = await setupServer();
    try {
      const clientId = "cursor-project";
      const policy: PolicyOptions = { keepPerServer: 1 };
      const previewRes = await apiPost(server, "/api/apply/preview", { policy, clientId });
      const previewData = await previewRes.json();
      const body = {
        policy,
        clientId,
        previewHash: previewData.currentHash,
        previewToken: previewData.previewToken,
        confirmation: "apply",
      };
      expect((await apiPost(server, "/api/apply", body)).status).toBe(200);
      const second = await apiPost(server, "/api/apply", body);
      expect(second.status).toBe(409);
      expect(await second.text()).toMatch(/already applied/i);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
