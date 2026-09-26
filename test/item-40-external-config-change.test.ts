import { describe, it, expect } from "vitest";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { apiPost, serverOrigin } from "./helpers/uiServer.js";
import { analyzeTools } from "../src/pipeline.js";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { PolicyOptions, Report, Tool } from "../src/types.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function buildReport(serverNames: string[]): Report {
  const tools: Tool[] = serverNames.flatMap((server) => [
    {
      server,
      name: "t1",
      description: "d ".repeat(20),
      inputSchema: { type: "object", properties: { x: { type: "string" } } },
    },
  ]);
  const servers = serverNames.map((name) => ({ name, status: "ok" as const }));
  return analyzeTools(tools, servers);
}

async function setupServer(
  mcpServers: Record<string, unknown>
): Promise<{ server: ServerInstance; testDir: string; mcpPath: string; content: string }> {
  const testDir = await mkdtemp(path.join(os.tmpdir(), "item40-"));
  const cursorDir = path.join(testDir, ".cursor");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cursorDir, { recursive: true });
  const mcpPath = path.join(cursorDir, "mcp.json");
  const config = { mcpServers };
  const content = JSON.stringify(config, null, 2) + "\n";
  await writeFile(mcpPath, content, "utf8");
  const report = buildReport(Object.keys(mcpServers));
  const server = await startServer({
    port: 0,
    onReady: () => {},
    getReport: () => report,
    configPath: mcpPath,
    originalConfig: config,
    cwd: testDir,
    initialAnalyzedContent: content,
  });
  return { server, testDir, mcpPath, content };
}

function postJson(server: ServerInstance, apiPath: string, body: unknown): Promise<Response> {
  return apiPost(server, apiPath, body);
}

async function expectNoBackupFiles(cursorDir: string): Promise<void> {
  const names = await readdir(cursorDir);
  expect(names.some((n) => n.includes(".bak"))).toBe(false);
}

describe("item 40: external config changes require re-analyze", () => {
  it("returns 409 on preview when a server is added externally", async () => {
    const base = {
      small: { command: "node", args: ["s.js"] },
      big: { command: "node", args: ["b.js"] },
      remote: { url: "https://example.com/mcp" },
    };
    const { server, testDir, mcpPath } = await setupServer(base);
    try {
      const tampered = {
        ...base,
        "late-added": { command: "node", args: ["late.js"] },
      };
      await writeFile(mcpPath, JSON.stringify({ mcpServers: tampered }, null, 2) + "\n", "utf8");

      const policy: PolicyOptions = {};
      const res = await apiPost(server, "/api/apply/preview", {
        policy,
        clientId: "cursor-project",
      });
      expect(res.status).toBe(409);
      const text = await res.text();
      expect(text).toMatch(/dashboard is refreshing|config changed/i);
      const onDisk = await readFile(mcpPath, "utf8");
      expect(onDisk).toContain("late-added");
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("returns 409 on preview when a server is removed externally", async () => {
    const base = {
      small: { command: "node", args: ["s.js"] },
      big: { command: "node", args: ["b.js"] },
      remote: { url: "https://example.com/mcp" },
    };
    const { server, testDir, mcpPath } = await setupServer( base);
    try {
      const removed = { small: base.small, remote: base.remote };
      await writeFile(mcpPath, JSON.stringify({ mcpServers: removed }, null, 2) + "\n", "utf8");

      const res = await postJson(server, "/api/apply/preview", {
        policy: {},
        clientId: "cursor-project",
      });
      expect(res.status).toBe(409);
      const text = await res.text();
      expect(text).toMatch(/dashboard is refreshing|server set|config changed/i);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("returns 409 on apply after external add without writing or backup", async () => {
    const base = {
      small: { command: "node", args: ["s.js"] },
      big: { command: "node", args: ["b.js"] },
    };
    const { server, testDir, mcpPath } = await setupServer(base);
    const cursorDir = path.dirname(mcpPath);
    try {
      const policy: PolicyOptions = { keepPerServer: 1 };
      const previewRes = await postJson(server, "/api/apply/preview", {
        policy,
        clientId: "cursor-project",
      });
      expect(previewRes.status).toBe(200);
      const previewData = await previewRes.json();

      const tampered = {
        ...base,
        "late-added": { command: "node", args: ["late.js"] },
      };
      const tamperedBody = JSON.stringify({ mcpServers: tampered }, null, 2) + "\n";
      await writeFile(mcpPath, tamperedBody, "utf8");
      const hashBeforeApply = sha256(tamperedBody);

      const applyRes = await postJson(server, "/api/apply", {
        policy,
        clientId: "cursor-project",
        previewHash: previewData.currentHash,
        previewToken: previewData.previewToken,
        confirmation: "apply",
      });
      expect(applyRes.status).toBe(409);
      const after = await readFile(mcpPath, "utf8");
      expect(sha256(after)).toBe(hashBeforeApply);
      await expectNoBackupFiles(cursorDir);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("returns 409 on preview when a server is renamed externally", async () => {
    const base = {
      small: { command: "node", args: ["s.js"] },
      big: { command: "node", args: ["b.js"] },
    };
    const { server, testDir, mcpPath } = await setupServer(base);
    try {
      const renamed = {
        "small-renamed": { command: "node", args: ["s.js"] },
        big: { command: "node", args: ["b.js"] },
      };
      await writeFile(mcpPath, JSON.stringify({ mcpServers: renamed }, null, 2) + "\n", "utf8");

      const res = await postJson(server, "/api/apply/preview", {
        policy: {},
        clientId: "cursor-project",
      });
      expect(res.status).toBe(409);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("preview still works immediately after our own apply", async () => {
    const base = {
      big: { command: "node", args: ["b.js"] },
      small: { command: "node", args: ["s.js"] },
    };
    const report = buildReport(["big", "small"]);
    report.tools = [
      ...report.tools,
      {
        server: "big",
        name: "t2",
        description: "x ".repeat(40),
        inputSchema: { type: "object", properties: { a: { type: "string" } } },
      },
    ];
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item40-apply-"));
    const cursorDir = path.join(testDir, ".cursor");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cursorDir, { recursive: true });
    const mcpPath = path.join(cursorDir, "mcp.json");
    const content = JSON.stringify({ mcpServers: base }, null, 2) + "\n";
    await writeFile(mcpPath, content, "utf8");
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      configPath: mcpPath,
      originalConfig: { mcpServers: base },
      cwd: testDir,
      initialAnalyzedContent: content,
    });
    try {
      const policy: PolicyOptions = { disableServersOver: 50 };
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
      const applyRes = await fetch(`${origin}/api/apply`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({
          policy,
          clientId: "cursor-project",
          previewHash: previewData.currentHash,
          previewToken: previewData.previewToken,
          confirmation: "apply",
        }),
      });
      expect(applyRes.status).toBe(200);
      const previewAgain = await fetch(`${origin}/api/apply/preview`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ policy, clientId: "cursor-project" }),
      });
      expect(previewAgain.status).toBe(200);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("after our apply, external add late-added blocks preview and apply and preserves file", async () => {
    const base = {
      small: { command: "node", args: ["s.js"] },
      big: { command: "node", args: ["b.js"] },
      remote: { url: "https://example.com/mcp" },
    };
    const report = buildReport(["small", "big", "remote"]);
    report.tools.push({
      server: "big",
      name: "t2",
      description: "x ".repeat(40),
      inputSchema: { type: "object", properties: { a: { type: "string" } } },
    });
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item40-late-"));
    const cursorDir = path.join(testDir, ".cursor");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cursorDir, { recursive: true });
    const mcpPath = path.join(cursorDir, "mcp.json");
    const content = JSON.stringify({ mcpServers: base }, null, 2) + "\n";
    await writeFile(mcpPath, content, "utf8");
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      configPath: mcpPath,
      originalConfig: { mcpServers: base },
      cwd: testDir,
      initialAnalyzedContent: content,
    });
    try {
      const policy: PolicyOptions = { disableServersOver: 50 };
      const previewOk = await postJson(server, "/api/apply/preview", {
        policy,
        clientId: "cursor-project",
      });
      expect(previewOk.status).toBe(200);
      const previewData = await previewOk.json();
      const applyOk = await postJson(server, "/api/apply", {
        policy,
        clientId: "cursor-project",
        previewHash: previewData.currentHash,
        previewToken: previewData.previewToken,
        confirmation: "apply",
      });
      expect(applyOk.status).toBe(200);

      const withLate = {
        ...base,
        "late-added": { command: "node", args: ["late.js"] },
      };
      const lateContent = JSON.stringify({ mcpServers: withLate }, null, 2) + "\n";
      await writeFile(mcpPath, lateContent, "utf8");

      const previewBlocked = await postJson(server, "/api/apply/preview", {
        policy,
        clientId: "cursor-project",
      });
      expect(previewBlocked.status).toBe(409);

      const applyBlocked = await postJson(server, "/api/apply", {
        policy,
        clientId: "cursor-project",
        previewHash: previewData.currentHash,
        previewToken: previewData.previewToken,
        confirmation: "apply",
      });
      expect(applyBlocked.status).toBe(409);

      const onDisk = await readFile(mcpPath, "utf8");
      expect(onDisk).toContain("late-added");
      await expectNoBackupFiles(cursorDir);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("after our apply, external rename blocks preview and apply and preserves renamed server", async () => {
    const base = {
      small: { command: "node", args: ["s.js"] },
      big: { command: "node", args: ["b.js"] },
      remote: { url: "https://example.com/mcp" },
    };
    const report = buildReport(["small", "big", "remote"]);
    report.tools.push({
      server: "big",
      name: "t2",
      description: "x ".repeat(40),
      inputSchema: { type: "object", properties: { a: { type: "string" } } },
    });
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item40-rename-"));
    const cursorDir = path.join(testDir, ".cursor");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cursorDir, { recursive: true });
    const mcpPath = path.join(cursorDir, "mcp.json");
    const content = JSON.stringify({ mcpServers: base }, null, 2) + "\n";
    await writeFile(mcpPath, content, "utf8");
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      configPath: mcpPath,
      originalConfig: { mcpServers: base },
      cwd: testDir,
      initialAnalyzedContent: content,
    });
    try {
      const policy: PolicyOptions = { disableServersOver: 50 };
      const previewOk = await postJson(server, "/api/apply/preview", {
        policy,
        clientId: "cursor-project",
      });
      expect(previewOk.status).toBe(200);
      const previewData = await previewOk.json();
      const applyOk = await postJson(server, "/api/apply", {
        policy,
        clientId: "cursor-project",
        previewHash: previewData.currentHash,
        previewToken: previewData.previewToken,
        confirmation: "apply",
      });
      expect(applyOk.status).toBe(200);

      const renamed = {
        "small-renamed": base.small,
        big: base.big,
        remote: base.remote,
      };
      await writeFile(mcpPath, JSON.stringify({ mcpServers: renamed }, null, 2) + "\n", "utf8");

      const previewBlocked = await postJson(server, "/api/apply/preview", {
        policy,
        clientId: "cursor-project",
      });
      expect(previewBlocked.status).toBe(409);

      const applyBlocked = await postJson(server, "/api/apply", {
        policy,
        clientId: "cursor-project",
        previewHash: previewData.currentHash,
        previewToken: previewData.previewToken,
        confirmation: "apply",
      });
      expect(applyBlocked.status).toBe(409);

      const onDisk = await readFile(mcpPath, "utf8");
      expect(onDisk).toContain("small-renamed");
      expect(onDisk).not.toContain('"small":');
      await expectNoBackupFiles(cursorDir);
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
