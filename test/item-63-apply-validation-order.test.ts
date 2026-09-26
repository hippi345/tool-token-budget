import { describe, it, expect } from "vitest";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { serverOrigin } from "./helpers/uiServer.js";
import { analyzeTools } from "../src/pipeline.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";

describe("item 63: apply validation order", () => {
  it("returns 403 view-only before 400 previewToken required", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item63-"));
    const copilotDir = path.join(os.homedir(), ".copilot");
    await mkdir(copilotDir, { recursive: true });
    const mcpPath = path.join(copilotDir, "mcp-config.json");
    const content = JSON.stringify({ mcpServers: {} }, null, 2) + "\n";
    await writeFile(mcpPath, content, "utf8");
    const report = analyzeTools([], []);
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      configPath: mcpPath,
      originalConfig: {},
      cwd: testDir,
      initialAnalyzedContent: content,
    });
    try {
      const origin = serverOrigin(server);
      const res = await fetch(`${origin}/api/apply`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({
          policy: {},
          clientId: "copilot-agent-host",
          previewHash: "abc",
          confirmation: "apply",
        }),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/view-only/i);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("returns 422 tools-json before 400 previewToken required", async () => {
    const report = analyzeTools([], []);
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      reportSource: "tools-json",
    });
    try {
      const origin = serverOrigin(server);
      const res = await fetch(`${origin}/api/apply`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({
          policy: {},
          clientId: "cursor-project",
          previewHash: "abc",
          confirmation: "apply",
        }),
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toMatch(/tools-json/i);
    } finally {
      await server.close();
    }
  });
});
