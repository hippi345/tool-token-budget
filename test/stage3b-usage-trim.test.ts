import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, utimes, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyzeTools } from "../src/pipeline.js";
import { loadToolsJson } from "../src/discover/fromToolsJson.js";
import { scanToolUsage } from "../src/usage/collectUsage.js";
import { attachUsageToReport, applyUsageAwareHotSet } from "../src/usage/usageTrim.js";
import { formatTextReport } from "../src/report/formatText.js";
import { writeArtifacts } from "../src/emit/writeArtifacts.js";
import { parseSinceOption } from "../src/usage/since.js";
import { keepProposalWritePath } from "../src/emit/keepArtifact.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureLogRoot = path.join(repoRoot, "fixtures", "usage-logs");
const CLI = path.join(repoRoot, "dist", "cli.js");
const FIXED_NOW = Date.parse("2026-03-26T12:00:00.000Z");

describe("stage3b usage-aware trim", () => {
  let emptyHomeLogs: string;

  beforeEach(async () => {
    emptyHomeLogs = await mkdtemp(path.join(tmpdir(), "stage3b-empty-logs-"));
    await mkdir(path.join(emptyHomeLogs, "claude-code"), { recursive: true });
    await mkdir(path.join(emptyHomeLogs, "codex"), { recursive: true });
    await mkdir(path.join(emptyHomeLogs, "cursor"), { recursive: true });
  });

  afterEach(async () => {
    await rm(emptyHomeLogs, { recursive: true, force: true });
  });

  it("stage3b-since-window-excludes-old-transcript-lines", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stage3b-since-"));
    const claudeRoot = path.join(dir, "claude-code", "p");
    await mkdir(claudeRoot, { recursive: true });
    const logFile = path.join(claudeRoot, "s.jsonl");
    await writeFile(
      logFile,
      [
        '{"type":"assistant","timestamp":"2020-01-01T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"mcp__tiny__echo","id":"1","input":{}}]}}',
        '{"type":"assistant","timestamp":"2026-03-20T12:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"mcp__tiny__ping","id":"2","input":{}}]}}',
      ].join("\n") + "\n",
      "utf8"
    );
    const recent = new Date(FIXED_NOW - 86400000);
    await utimes(logFile, recent, recent);

    const scan = await scanToolUsage({
      since: "30d",
      now: FIXED_NOW,
      logRoots: {
        claudeCode: path.join(dir, "claude-code"),
        codex: path.join(dir, "codex"),
        cursor: path.join(dir, "cursor"),
      },
    });
    expect(scan.counts["tiny::ping"]).toBe(1);
    expect(scan.counts["tiny::echo"]).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("stage3b-analyze-used-vs-unused-from-fixtures", async () => {
    const { servers, tools } = await loadToolsJson(
      path.join(repoRoot, "fixtures", "tools-tiny.json")
    );
    const report = analyzeTools(tools, servers);
    const scan = await scanToolUsage({
      since: "30d",
      now: FIXED_NOW,
      logRoots: {
        claudeCode: path.join(fixtureLogRoot, "claude-code"),
        codex: path.join(fixtureLogRoot, "codex"),
        cursor: path.join(fixtureLogRoot, "cursor"),
      },
    });
    const enriched = attachUsageToReport(report, scan);
    const ping = enriched.usage!.tools.find((t) => t.tool === "ping");
    const echo = enriched.usage!.tools.find((t) => t.tool === "echo");
    expect(ping?.used).toBe(true);
    expect(ping!.callCount).toBeGreaterThanOrEqual(3);
    expect(echo?.used).toBe(false);
    expect(echo!.callCount).toBe(0);
  });

  it("stage3b-emit-usage-defer-savings-math", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "stage3b-emit-"));
    const { servers, tools } = await loadToolsJson(
      path.join(repoRoot, "fixtures", "tools-tiny.json")
    );
    const report = analyzeTools(tools, servers);
    const scan = await scanToolUsage({
      since: "30d",
      now: FIXED_NOW,
      logRoots: {
        claudeCode: path.join(fixtureLogRoot, "claude-code"),
        codex: path.join(fixtureLogRoot, "codex"),
        cursor: path.join(fixtureLogRoot, "cursor"),
      },
    });
    const { usageDeferKeys } = applyUsageAwareHotSet(report.tools, { keepPerServer: 2 }, scan);
    const echoMeter = report.tools.find((t) => t.name === "echo")!;
    expect(usageDeferKeys.has("tiny::echo")).toBe(true);
    const enriched = attachUsageToReport(report, scan, usageDeferKeys);
    expect(enriched.usage!.usageDeferSavingsEstTokens).toBe(echoMeter.estTokens);

    await writeArtifacts(outDir, attachUsageToReport(report, scan), {
      format: "both",
      policy: { keepPerServer: 2 },
      usageScan: scan,
    });
    const keep = JSON.parse(
      await readFile(keepProposalWritePath(outDir), "utf8")
    );
    expect(keep.defer).toContain("tiny::echo");
    await rm(outDir, { recursive: true, force: true });
  });

  it("stage3b-no-logs-plain-message", async () => {
    const scan = await scanToolUsage({
      since: "30d",
      now: FIXED_NOW,
      logRoots: {
        claudeCode: path.join(emptyHomeLogs, "claude-code"),
        codex: path.join(emptyHomeLogs, "codex"),
        cursor: path.join(emptyHomeLogs, "cursor"),
      },
    });
    const { servers, tools } = await loadToolsJson(
      path.join(repoRoot, "fixtures", "tools-tiny.json")
    );
    const enriched = attachUsageToReport(analyzeTools(tools, servers), scan);
    expect(enriched.usage!.noLogsPlainMessage).toMatch(/No MCP tool calls found in client logs/);
  });

  it("stage3b-output-never-includes-log-line-secrets", () => {
    const out = execSync(
      `node "${CLI}" analyze --tools-json fixtures/tools-tiny.json --since 30d --usage-log-dir "${fixtureLogRoot}" --no-usage 2>&1`,
      { cwd: repoRoot, encoding: "utf8" }
    );
    expect(out).not.toContain("SECRET_SHOULD_NOT_LEAK");

    const withUsage = execSync(
      `node "${CLI}" analyze --tools-json fixtures/tools-tiny.json --since 30d --usage-log-dir "${fixtureLogRoot}" 2>&1`,
      { cwd: repoRoot, encoding: "utf8" }
    );
    expect(withUsage).not.toContain("SECRET_SHOULD_NOT_LEAK");
    expect(withUsage).not.toContain("private");
    expect(withUsage).toMatch(/ping.*calls/i);
  });

  it("stage3b-parse-since-accepts-iso-date", () => {
    const d = parseSinceOption("2026-03-01T00:00:00.000Z");
    expect(d.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("stage3b-text-report-lists-client-status-without-paths", async () => {
    const { servers, tools } = await loadToolsJson(
      path.join(repoRoot, "fixtures", "tools-tiny.json")
    );
    const scan = await scanToolUsage({
      logRoots: {
        claudeCode: path.join(fixtureLogRoot, "claude-code"),
        codex: path.join(fixtureLogRoot, "codex"),
        cursor: path.join(fixtureLogRoot, "cursor"),
      },
      now: FIXED_NOW,
    });
    const text = formatTextReport(attachUsageToReport(analyzeTools(tools, servers), scan));
    expect(text).toContain("claude-code:");
    expect(text).not.toContain("fixtures/usage-logs");
    expect(text).not.toContain("sess.jsonl");
  });
});
