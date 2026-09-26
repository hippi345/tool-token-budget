import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverFromMcpConfig } from "../src/discover/fromMcpConfig.js";
import { analyzeTools, formatTextReport } from "../src/pipeline.js";
import { formatHtml } from "../src/report/formatHtml.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpSecretsPath = path.join(__dirname, "../fixtures/mcp-with-secrets.json");
const mcpMixedPath = path.join(__dirname, "../fixtures/mcp-mixed.json");

describe("integration: live stub MCP server", () => {
  it("spawns stub-mcp-server.mjs, lists tools, meters, exits 0", async () => {
    const warnings: string[] = [];
    const { servers, tools } = await discoverFromMcpConfig(mcpSecretsPath, {
      timeoutMs: 10_000,
      onWarn: (msg) => warnings.push(msg),
    });

    // stub server should succeed
    const stubServer = servers.find((s) => s.name === "stub");
    expect(stubServer).toBeDefined();
    expect(stubServer?.status).toBe("ok");
    expect(stubServer?.error).toBeUndefined();

    // remote should warn+skip
    const remoteServer = servers.find((s) => s.name === "remote-example");
    expect(remoteServer).toBeDefined();
    expect(remoteServer?.status).toBe("skipped_remote");
    expect(warnings.some((w) => w.includes("remote-example"))).toBe(true);

    // stub should list at least one tool
    const stubTools = tools.filter((t) => t.server === "stub");
    expect(stubTools.length).toBeGreaterThan(0);

    // meter should work
    const report = analyzeTools(tools, servers);
    expect(report.totals.estTokens).toBeGreaterThan(0);
  }, 15_000);

  it("mixed config: stub ok, missing binary spawns fails, remotes skip", async () => {
    const warnings: string[] = [];
    const { servers, tools } = await discoverFromMcpConfig(mcpMixedPath, {
      timeoutMs: 10_000,
      onWarn: (msg) => warnings.push(msg),
    });

    // stub should succeed
    const stubServer = servers.find((s) => s.name === "stub");
    expect(stubServer?.status).toBe("ok");

    // missing binary should fail
    // Windows may report handshake_failed instead of spawn_failed if the spawn
    // appears to succeed but the binary doesn't exist (ENOENT in child process)
    const missingServer = servers.find((s) => s.name === "missing-binary");
    expect(["spawn_failed", "handshake_failed"]).toContain(missingServer?.status);
    // Error message now includes command name on all platforms
    expect(missingServer?.error).toContain("nonexistent-binary-xyz");

    // remote entries should skip
    const remoteServers = servers.filter((s) => s.status === "skipped_remote");
    expect(remoteServers.length).toBe(2);
    expect(warnings.some((w) => w.includes("remote-sse"))).toBe(true);
    expect(warnings.some((w) => w.includes("remote-http"))).toBe(true);

    // only stub tools should be present
    expect(tools.every((t) => t.server === "stub")).toBe(true);
  }, 15_000);
});

describe("integration: secrets redaction", () => {
  it("text report never contains secret env values", async () => {
    const { servers, tools } = await discoverFromMcpConfig(mcpSecretsPath, {
      timeoutMs: 10_000,
      onWarn: () => {},
    });

    const report = analyzeTools(tools, servers);
    const text = formatTextReport(report);

    expect(text).not.toContain("should-never-appear-in-reports");
    expect(text).not.toContain("fake-api-key-do-not-leak");
    expect(text).not.toContain("SECRET_TOKEN");
    expect(text).not.toContain("API_KEY");
  }, 15_000);

  it("JSON report never contains secret env values", async () => {
    const { servers, tools } = await discoverFromMcpConfig(mcpSecretsPath, {
      timeoutMs: 10_000,
      onWarn: () => {},
    });

    const report = analyzeTools(tools, servers);
    const jsonStr = JSON.stringify(report, null, 2);

    expect(jsonStr).not.toContain("should-never-appear-in-reports");
    expect(jsonStr).not.toContain("fake-api-key-do-not-leak");
  }, 15_000);

  it("HTML report never contains secret env values", async () => {
    const { servers, tools } = await discoverFromMcpConfig(mcpSecretsPath, {
      timeoutMs: 10_000,
      onWarn: () => {},
    });

    const report = analyzeTools(tools, servers);
    const html = formatHtml(report);

    expect(html).not.toContain("should-never-appear-in-reports");
    expect(html).not.toContain("fake-api-key-do-not-leak");
  }, 15_000);
});
