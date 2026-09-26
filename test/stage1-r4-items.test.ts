import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { analyzeToolsAsync } from "../src/pipeline.js";
import { formatTextReport } from "../src/report/formatText.js";
import { loadToolsJson } from "../src/discover/fromToolsJson.js";
import {
  getHfTokenCounter,
  resetHfTokenCounters,
  setHfDownloadFn,
  setHfPeerInstalledCheck,
  resetHfDownloadCallCount,
  getHfDownloadCallCount,
  HfDownloadHttpError,
} from "../src/meter/hfTokenize.js";
import { resetCountMemo } from "../src/meter/perModel.js";
import {
  resetCatalogTokenizerCallCount,
  getCatalogTokenizerCallCount,
} from "../src/meter/catalogCountMetrics.js";
import { setMeterVerbose } from "../src/meter/meterVerbose.js";
import { startServer } from "../src/ui/server.js";
import { apiPost } from "./helpers/uiServer.js";
import { analyzeTools } from "../src/pipeline.js";
import { buildModelSelectOptions } from "../gui/src/modelPresetOptions.js";
import { countModeDisplayLabel } from "../gui/src/countModeDisplay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, "../dist/cli.js");
const bloatedPath = path.join(__dirname, "../fixtures/tools-bloated.json");
const tinyPath = path.join(__dirname, "../fixtures/tools-tiny.json");

const FIXTURE_TOOL = {
  server: "s",
  name: "search",
  description: "Find things",
  inputSchema: { type: "object" },
};

describe("Stage 1 review round 4", () => {
  beforeEach(() => {
    resetCountMemo();
    resetHfTokenCounters();
    resetHfDownloadCallCount();
    resetCatalogTokenizerCallCount();
    setHfDownloadFn(undefined);
    setHfPeerInstalledCheck(undefined);
    setMeterVerbose(false);
  });

  afterEach(() => {
    setHfDownloadFn(undefined);
    setHfPeerInstalledCheck(undefined);
    setMeterVerbose(false);
    vi.restoreAllMocks();
  });

  it("stage1-r4-item1: model options always include primary and openai:o200k", () => {
    const opts = buildModelSelectOptions([], "cursor-dynamic");
    const ids = opts.map((o) => o.id);
    expect(ids).toContain("cursor-dynamic");
    expect(ids).toContain("openai:o200k");
  });

  it("stage1-r4-item3: HF downloader not called when peer is missing", async () => {
    setHfPeerInstalledCheck(async () => false);
    setMeterVerbose(true);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await getHfTokenCounter("meta-llama/Llama-3.1-8B", path.join(tmpdir(), "r4-no-peer"));
    expect(getHfDownloadCallCount()).toBe(0);
    const line = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toMatch(/peer not installed/i);
    errSpy.mockRestore();
  });

  it("stage1-r4-item4a: gated HF download logs token env hint", async () => {
    setHfPeerInstalledCheck(async () => true);
    setHfDownloadFn(async () => {
      throw new HfDownloadHttpError(401, "HTTP 401");
    });
    setMeterVerbose(true);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await getHfTokenCounter("meta-llama/Llama-3.1-8B", path.join(tmpdir(), "r4-gated"));
    const line = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toMatch(/gated or unauthorized/i);
    expect(line).toMatch(/HF_TOKEN/);
    expect(line).not.toMatch(/failed to initialize/i);
    errSpy.mockRestore();
  });

  it("stage1-r4-item4b: peer missing verbose reason", async () => {
    setHfPeerInstalledCheck(async () => false);
    setMeterVerbose(true);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await getHfTokenCounter("meta-llama/Llama-3.1-8B", path.join(tmpdir(), "r4-peer-miss"));
    const line = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toMatch(/peer not installed/i);
    expect(line).toMatch(/@huggingface\/tokenizers/);
    errSpy.mockRestore();
  });

  it("stage1-r4-item4c: offline cache miss verbose reason", async () => {
    setHfPeerInstalledCheck(async () => true);
    setHfDownloadFn(async () => {
      throw new Error("network down");
    });
    setMeterVerbose(true);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await getHfTokenCounter("meta-llama/Llama-3.1-8B", path.join(tmpdir(), "r4-offline"));
    const line = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toMatch(/offline or cache miss/i);
    errSpy.mockRestore();
  });

  it("stage1-r4-item5: count mode display label maps health modes", () => {
    expect(countModeDisplayLabel("offline")).toBe("estimate");
    expect(
      countModeDisplayLabel("api", {
        optionalApis: { anthropic: true },
        primarySummary: { source: "exact-api" },
      })
    ).toBe("api (exact)");
    expect(
      countModeDisplayLabel("auto", {
        optionalApis: { anthropic: true },
        primarySummary: { source: "exact-api" },
      })
    ).toBe("auto (exact)");
  });

  it("stage1-r4-item7: cursor-catalog marginals plus overhead equal total", async () => {
    const { servers, tools } = await loadToolsJson(bloatedPath);
    const report = await analyzeToolsAsync(tools, servers, {
      modelIds: ["cursor-dynamic"],
      countMode: "offline",
    });
    const summary = report.tokenCountsByModel?.["cursor-dynamic"];
    expect(summary).toBeDefined();
    const marginalSum = Object.values(summary!.perTool).reduce((a, b) => a + b, 0);
    const overhead = summary!.framingOverhead ?? 0;
    expect(marginalSum + overhead).toBe(summary!.total);
  });

  it("stage1-r4-item8: openai:o200k uses estimate label in text report", async () => {
    const { servers, tools } = await loadToolsJson(bloatedPath);
    const report = await analyzeToolsAsync(tools, servers, {
      modelIds: ["openai:o200k"],
      countMode: "offline",
    });
    const text = formatTextReport(report);
    expect(text).toMatch(/openai:o200k: ~\d+ tokens \(estimate/);
    expect(report.tokenCountsByModel?.["openai:o200k"]?.source).toBe("estimate");
  });

  it("stage1-r4-item9a: llama-hf-fixture rejected by API outside test mode", async () => {
    const prevExpose = process.env.TOOL_TOKEN_BUDGET_EXPOSE_TEST_MODELS;
    process.env.TOOL_TOKEN_BUDGET_EXPOSE_TEST_MODELS = "0";

    const testDir = await mkdtemp(path.join(tmpdir(), "r4-gate-api-"));
    const report = analyzeTools([FIXTURE_TOOL], [{ name: "s", status: "ok" }]);
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      cwd: testDir,
    });
    server.broadcast(
      {
        timestamp: new Date().toISOString(),
        servers: [{ name: "s", status: "ok" }],
        tools: [FIXTURE_TOOL],
        report,
      },
      null
    );
    const res = await apiPost(server, "/api/model-counts", {
      modelIds: ["llama-hf-fixture"],
    });
    expect(res.status).toBe(400);
    await server.close();
    await rm(testDir, { recursive: true, force: true });
    if (prevExpose !== undefined) {
      process.env.TOOL_TOKEN_BUDGET_EXPOSE_TEST_MODELS = prevExpose;
    } else {
      delete process.env.TOOL_TOKEN_BUDGET_EXPOSE_TEST_MODELS;
    }
  });

  it("stage1-r4-item9b: llama-hf-fixture allowed in NODE_ENV=test", async () => {
    const report = analyzeTools([FIXTURE_TOOL], [{ name: "s", status: "ok" }]);
    const testDir = await mkdtemp(path.join(tmpdir(), "r4-gate-ok-"));
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      cwd: testDir,
    });
    server.broadcast(
      {
        timestamp: new Date().toISOString(),
        servers: [{ name: "s", status: "ok" }],
        tools: [FIXTURE_TOOL],
        report,
      },
      null
    );
    const res = await apiPost(server, "/api/model-counts", {
      modelIds: ["llama-hf-fixture"],
    });
    expect(res.status).toBe(200);
    await server.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("stage1-r4-item9c: CLI rejects llama-hf-fixture outside test mode", () => {
    try {
      execSync(
        `node "${cliPath}" analyze --tools-json "${tinyPath}" --model llama-hf-fixture`,
        {
          encoding: "utf8",
          cwd: path.join(__dirname, ".."),
          env: {
            ...process.env,
            NODE_ENV: "production",
            TOOL_TOKEN_BUDGET_EXPOSE_TEST_MODELS: "0",
          },
        }
      );
      expect.fail("should exit");
    } catch (err: unknown) {
      const e = err as { status?: number };
      expect(e.status).toBe(2);
    }
  });

  it("stage1-r4-item10: cursor-catalog tokenizer calls scale at most ~2.5x when tools double", async () => {
    const { servers, tools } = await loadToolsJson(bloatedPath);
    const half = Math.max(2, Math.floor(tools.length / 2));
    const sliceA = tools.slice(0, half);
    const sliceB = tools.slice(0, half * 2);

    resetCatalogTokenizerCallCount();
    await analyzeToolsAsync(sliceA, servers, {
      modelIds: ["cursor-dynamic"],
      countMode: "offline",
    });
    const callsA = getCatalogTokenizerCallCount();

    resetCatalogTokenizerCallCount();
    await analyzeToolsAsync(sliceB, servers, {
      modelIds: ["cursor-dynamic"],
      countMode: "offline",
    });
    const callsB = getCatalogTokenizerCallCount();

    expect(callsB).toBeGreaterThan(callsA);
    expect(callsB / callsA).toBeLessThanOrEqual(2.5);
    expect(callsB / callsA).toBeGreaterThan(1);
  });
});
