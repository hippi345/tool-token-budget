import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { apiPost } from "./helpers/uiServer.js";
import { pollUntil } from "./poll-until.js";
import { analyzeTools } from "../src/pipeline.js";
import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { PolicyOptions, Tool } from "../src/types.js";
import { PreviewTokenStore } from "../src/ui/previewTokenStore.js";

async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath, "utf8");
  return createHash("sha256").update(content).digest("hex");
}

async function expectConfigUnchanged(mcpPath: string, beforeHash: string): Promise<void> {
  expect(await sha256File(mcpPath)).toBe(beforeHash);
  const names = await readdir(path.dirname(mcpPath));
  expect(names.some((n) => n.includes(".bak"))).toBe(false);
}

async function setupServer(opts?: { alsoClaudeCodeProject?: boolean }) {
  const testDir = await mkdtemp(path.join(os.tmpdir(), "item58-"));
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
  if (opts?.alsoClaudeCodeProject) {
    await writeFile(path.join(testDir, ".mcp.json"), content, "utf8");
  }
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
  return { server, testDir, mcpPath };
}

describe("item 58: preview token bound to policy and client", () => {
  it("rejects apply when policy mismatches preview token", async () => {
    const { server, testDir, mcpPath } = await setupServer();
    try {
      const beforeHash = await sha256File(mcpPath);
      const clientId = "cursor-project";
      const preview = await apiPost(server, "/api/apply/preview", {
        policy: {},
        clientId,
      });
      const data = await preview.json();
      const apply = await apiPost(server, "/api/apply", {
        policy: { disableServersOver: 500 },
        clientId,
        previewHash: data.currentHash,
        previewToken: data.previewToken,
        confirmation: "apply",
      });
      expect(apply.status).toBe(409);
      expect(await apply.text()).toMatch(/policy/i);
      await expectConfigUnchanged(mcpPath, beforeHash);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("rejects apply for wrong client id", async () => {
    const { server, testDir, mcpPath } = await setupServer({ alsoClaudeCodeProject: true });
    try {
      const beforeHash = await sha256File(mcpPath);
      const preview = await apiPost(server, "/api/apply/preview", {
        policy: {},
        clientId: "cursor-project",
      });
      const data = await preview.json();
      const apply = await apiPost(server, "/api/apply", {
        policy: {},
        clientId: "claude-code-project",
        previewHash: data.currentHash,
        previewToken: data.previewToken,
        confirmation: "apply",
      });
      expect(apply.status).toBe(409);
      expect(await apply.text()).toMatch(/client/i);
      await expectConfigUnchanged(mcpPath, beforeHash);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("expires and caps preview tokens in store", () => {
    const store = new PreviewTokenStore();
    const base = {
      targetPath: "/tmp/mcp.json",
      contentHash: "abc",
      clientId: "cursor-project",
      policyHash: "pol",
      baselineHash: "base",
    };
    const first = store.issue(base);
    store.pruneExpired(Date.now() + 16 * 60 * 1000);
    expect(store.get(first)).toBeUndefined();

    const tokens: string[] = [];
    for (let i = 0; i < 505; i++) {
      tokens.push(store.issue(base));
    }
    expect(store.get(tokens[0])).toBeUndefined();
    expect(store.get(tokens[tokens.length - 1])).toBeDefined();
  });

  const prevTtl = process.env.SCHEMA_BUDGET_PREVIEW_TOKEN_TTL_MS;
  const prevTtbTtl = process.env.TOOL_TOKEN_BUDGET_PREVIEW_TOKEN_TTL_MS;
  beforeEach(() => {
    delete process.env.SCHEMA_BUDGET_PREVIEW_TOKEN_TTL_MS;
    delete process.env.TOOL_TOKEN_BUDGET_PREVIEW_TOKEN_TTL_MS;
  });
  afterEach(() => {
    if (prevTtl === undefined) {
      delete process.env.SCHEMA_BUDGET_PREVIEW_TOKEN_TTL_MS;
    } else {
      process.env.SCHEMA_BUDGET_PREVIEW_TOKEN_TTL_MS = prevTtl;
    }
    if (prevTtbTtl === undefined) {
      delete process.env.TOOL_TOKEN_BUDGET_PREVIEW_TOKEN_TTL_MS;
    } else {
      process.env.TOOL_TOKEN_BUDGET_PREVIEW_TOKEN_TTL_MS = prevTtbTtl;
    }
  });

  it("rejects apply when preview token expired", async () => {
    process.env.TOOL_TOKEN_BUDGET_PREVIEW_TOKEN_TTL_MS = "40";
    const { server, testDir, mcpPath } = await setupServer();
    try {
      const beforeHash = await sha256File(mcpPath);
      const clientId = "cursor-project";
      const policy: PolicyOptions = { keepPerServer: 1 };
      const preview = await apiPost(server, "/api/apply/preview", {
        policy,
        clientId,
      });
      const data = await preview.json();
      const issuedAt = Date.now();
      await pollUntil(async () => Date.now() - issuedAt >= 60, {
        intervalMs: 10,
        timeoutMs: 2_000,
        label: "preview token TTL elapsed",
      });
      const apply = await apiPost(server, "/api/apply", {
        policy,
        clientId,
        previewHash: data.currentHash,
        previewToken: data.previewToken,
        confirmation: "apply",
      });
      expect(apply.status).toBe(409);
      expect(await apply.text()).toMatch(/expired|invalid/i);
      await expectConfigUnchanged(mcpPath, beforeHash);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("normal matching policy apply still succeeds", async () => {
    const { server, testDir } = await setupServer();
    try {
      const clientId = "cursor-project";
      const policy: PolicyOptions = { keepPerServer: 1 };
      const preview = await apiPost(server, "/api/apply/preview", {
        policy,
        clientId,
      });
      const data = await preview.json();
      const apply = await apiPost(server, "/api/apply", {
        policy,
        clientId,
        previewHash: data.currentHash,
        previewToken: data.previewToken,
        confirmation: "apply",
      });
      expect(apply.status).toBe(200);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
