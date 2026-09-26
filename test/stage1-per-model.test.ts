import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadToolsJson } from "../src/discover/fromToolsJson.js";
import { analyzeTools, analyzeToolsAsync } from "../src/pipeline.js";
import {
  buildAnthropicToolPayload,
  buildFullInjectPayload,
} from "../src/meter/framing.js";
import { estimateTokens } from "../src/meter/score.js";
import {
  countAnthropicToolsApi,
  resetApiFetchImpl,
  setApiFetchImpl,
} from "../src/meter/apiTokenCount.js";
import { apiConfiguredFlags } from "../src/meter/apiTokenCount.js";
import { resetCountMemo } from "../src/meter/perModel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bloatedPath = path.join(__dirname, "../fixtures/tools-bloated.json");
const cliPath = path.join(__dirname, "../dist/cli.js");

describe("Stage 1 Feature 5 — per-model token counts", () => {
  beforeEach(() => {
    resetCountMemo();
    resetApiFetchImpl();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    resetApiFetchImpl();
  });

  it("stage1-ac1: claude offline estimate differs from legacy o200k column", async () => {
    const { servers, tools } = await loadToolsJson(bloatedPath);
    const legacy = analyzeTools(tools, servers);
    const withModel = await analyzeToolsAsync(tools, servers, {
      primaryModelId: "claude-sonnet-4-5",
      modelIds: ["claude-sonnet-4-5"],
      countMode: "offline",
    });
    expect(withModel.tokenCountsByModel?.["claude-sonnet-4-5"]?.source).toBe(
      "estimate"
    );
    const claudeTotal = withModel.tokenCountsByModel?.["claude-sonnet-4-5"]?.total;
    expect(claudeTotal).toBeDefined();
    expect(claudeTotal).not.toBe(legacy.totals.estTokens);

    const output = execSync(
      `node "${cliPath}" analyze --tools-json "${bloatedPath}" --model claude-sonnet-4-5 --count-mode offline`,
      { encoding: "utf8", cwd: path.join(__dirname, "..") }
    );
    expect(output).toContain("claude-sonnet-4-5");
    expect(output).toContain("estimate");
    expect(output).toContain("legacy ranked column total");
  });

  it("stage1-ac2: auto mode uses mocked Anthropic API within 0% when key set", async () => {
    const tinyPath = path.join(__dirname, "../fixtures/tools-tiny.json");
    const { tools } = await loadToolsJson(tinyPath);
    const mockTotal = 4242;
    setApiFetchImpl(async () => ({
      ok: true,
      json: async () => ({ input_tokens: mockTotal }),
    } as Response));

    process.env.ANTHROPIC_API_KEY = "fake-sentinel-anthropic-key-never-log";

    const report = await analyzeToolsAsync(tools, [], {
      primaryModelId: "claude-sonnet-4-5",
      modelIds: ["claude-sonnet-4-5"],
      countMode: "auto",
    });
    expect(report.tokenCountsByModel?.["claude-sonnet-4-5"]?.source).toBe(
      "exact-api"
    );
    expect(report.tokenCountsByModel?.["claude-sonnet-4-5"]?.total).toBe(
      mockTotal
    );

    if (process.env.RUN_LIVE_API === "1") {
      const live = await countAnthropicToolsApi(
        tools.slice(0, 1),
        process.env.ANTHROPIC_API_KEY!,
        "claude-sonnet-4-5"
      );
      expect(live.total).toBeGreaterThan(0);
    }
  });

  it("stage1-ac3: report includes multi-model maps for GUI savings context", async () => {
    const { servers, tools } = await loadToolsJson(bloatedPath);
    const report = await analyzeToolsAsync(tools, servers, {
      modelIds: ["claude-sonnet-4-5", "gpt-4o"],
      countMode: "offline",
    });
    expect(Object.keys(report.tokenCountsByModel ?? {}).length).toBeGreaterThanOrEqual(
      2
    );
    const first = report.tools[0];
    expect(first.countsByModel?.["claude-sonnet-4-5"]).toBeGreaterThan(0);
    expect(first.countsByModel?.["gpt-4o"]).toBeGreaterThan(0);
  });

  it("stage1-ac4: doctor shows booleans only; outputs never contain API keys", async () => {
    process.env.ANTHROPIC_API_KEY = "SENTINEL_ANTHROPIC_KEY_stage1";
    process.env.GEMINI_API_KEY = "SENTINEL_GEMINI_KEY_stage1";

    const flags = apiConfiguredFlags();
    expect(flags.anthropic).toBe(true);
    expect(flags.gemini).toBe(true);

    const out = execSync(`node "${cliPath}" doctor`, {
      encoding: "utf8",
      cwd: path.join(__dirname, ".."),
    });
    expect(out).toContain("anthropic=true");
    expect(out).toContain("gemini=true");
    expect(out).not.toContain("SENTINEL_ANTHROPIC_KEY_stage1");
    expect(out).not.toContain("SENTINEL_GEMINI_KEY_stage1");

    const testDir = mkdtempSync(path.join(tmpdir(), "stage1-leak-"));
    try {
      const jsonOut = execSync(
        `node "${cliPath}" analyze --tools-json "${bloatedPath}" --model claude-sonnet-4-5 --json`,
        { encoding: "utf8", cwd: path.join(__dirname, ".."), env: process.env }
      );
      expect(jsonOut).not.toContain("SENTINEL_ANTHROPIC_KEY_stage1");
      expect(jsonOut).not.toContain("SENTINEL_GEMINI_KEY_stage1");
      const reportPath = path.join(testDir, "report.json");
      execSync(
        `node "${cliPath}" emit --tools-json "${bloatedPath}" --out "${testDir}" --model claude-sonnet-4-5`,
        { cwd: path.join(__dirname, ".."), env: process.env }
      );
      const reportJson = readFileSync(reportPath, "utf8");
      expect(reportJson).not.toContain("SENTINEL_GEMINI_KEY_stage1");
      expect(reportJson).not.toContain("SENTINEL_ANTHROPIC_KEY_stage1");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("stage1-ac5: default single-column rank order unchanged", async () => {
    const { servers, tools } = await loadToolsJson(bloatedPath);
    const before = analyzeTools(tools, servers);
    const after = analyzeTools(tools, servers, {
      primaryModelId: "openai:o200k",
      modelIds: ["openai:o200k"],
    });
    const top10Before = before.tools.slice(0, 10).map((t) => t.name);
    const top10After = after.tools.slice(0, 10).map((t) => t.name);
    expect(top10After).toEqual(top10Before);
    expect(before.tools[0].name).toBe("mega_search");
  });

  it("stage1-ac6: bloated fixture offline analyze completes under 2s", async () => {
    const { servers, tools } = await loadToolsJson(bloatedPath);
    const start = performance.now();
    await analyzeToolsAsync(tools, servers, {
      modelIds: ["claude-sonnet-4-5", "gpt-4o", "gemini-2.0-flash", "cursor-dynamic"],
      countMode: "offline",
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it("framing: anthropic-shaped string differs from full inject for tiny tool", () => {
    const tool = {
      server: "s",
      name: "search",
      description: "Find things",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    };
    const anthropic = buildAnthropicToolPayload(tool);
    const full = buildFullInjectPayload(tool);
    expect(anthropic).not.toBe(full);
    expect(estimateTokens(anthropic)).not.toBe(estimateTokens(full));
  });
});
