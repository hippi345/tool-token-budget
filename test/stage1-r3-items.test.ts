import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { analyzeToolsAsync, analyzeTools, formatTextReport } from "../src/pipeline.js";
import { loadToolsJson } from "../src/discover/fromToolsJson.js";
import {
  getHfTokenCounter,
  resetHfTokenCounters,
  setHfDownloadFn,
  setHfPeerInstalledCheck,
} from "../src/meter/hfTokenize.js";
import { resetCountMemo } from "../src/meter/perModel.js";
import {
  resetApiFetchImpl,
  setApiFetchImpl,
} from "../src/meter/apiTokenCount.js";
import { setMeterVerbose } from "../src/meter/meterVerbose.js";
import { listPresetModelsForUi } from "../src/meter/modelCatalog.js";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { apiPost, serverOrigin } from "./helpers/uiServer.js";

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

describe("Stage 1 review round 3", () => {
  beforeEach(() => {
    resetCountMemo();
    resetHfTokenizers();
    resetApiFetchImpl();
    setHfDownloadFn(undefined);
    setHfPeerInstalledCheck(undefined);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    resetApiFetchImpl();
    setHfDownloadFn(undefined);
    setHfPeerInstalledCheck(undefined);
    setMeterVerbose(false);
  });

  it("stage1-r3-item1: cursor-catalog total bounded and scales sub-quadratically", async () => {
    const { servers, tools } = await loadToolsJson(bloatedPath);
    const full = await analyzeToolsAsync(tools, servers, {
      modelIds: ["openai:o200k", "cursor-dynamic"],
      countMode: "offline",
    });
    const legacyTotal = full.tokenCountsByModel?.["openai:o200k"]?.total ?? 0;
    const catalogTotal = full.tokenCountsByModel?.["cursor-dynamic"]?.total ?? 0;
    expect(catalogTotal).toBeLessThanOrEqual(legacyTotal * 1.5);
    expect(catalogTotal).toBeGreaterThan(0);

    const slice4 = tools.slice(0, 4);
    const slice8 = tools.slice(0, 8);
    const r4 = await analyzeToolsAsync(slice4, servers, {
      modelIds: ["cursor-dynamic"],
      countMode: "offline",
    });
    const r8 = await analyzeToolsAsync(slice8, servers, {
      modelIds: ["cursor-dynamic"],
      countMode: "offline",
    });
    const t4 = r4.tokenCountsByModel?.["cursor-dynamic"]?.total ?? 0;
    const t8 = r8.tokenCountsByModel?.["cursor-dynamic"]?.total ?? 0;
    expect(t8).toBeGreaterThan(t4);
    const ratio = t8 / Math.max(t4, 1);
    expect(ratio).toBeLessThan(2.5);
    expect(ratio).toBeGreaterThan(1);
  });

  it("stage1-r3-item2: API returns primary model counts with a single model id", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "r3-primary-only-"));
    const tools = [FIXTURE_TOOL];
    const servers = [{ name: "s", status: "ok" as const }];
    const report = analyzeTools(tools, servers);
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      cwd: testDir,
    });
    server.broadcast(
      { timestamp: new Date().toISOString(), servers, tools, report },
      null
    );
    const res = await apiPost(server, "/api/model-counts", {
      modelIds: ["gpt-4o"],
      primaryModelId: "gpt-4o",
      countMode: "offline",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokenCountsByModel["gpt-4o"]?.total).toBeGreaterThan(0);
    await server.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("stage1-r3-item3: health exposes server countMode for GUI", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "r3-health-mode-"));
    const report = analyzeTools([FIXTURE_TOOL], [{ name: "s", status: "ok" }]);
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      cwd: testDir,
      meterAnalyzeOpts: { countMode: "auto", modelIds: ["gpt-4o"] },
    });
    const origin = serverOrigin(server);
    const health = await fetch(`${origin}/api/health`, {
      headers: { "X-Auth-Token": server.token },
    });
    expect(health.status).toBe(200);
    const body = await health.json();
    expect(body.countMode).toBe("auto");
    await server.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("stage1-r3-item4: HF download uses injected fetch into cache dir only", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "r3-hf-cache-"));
    const fakeJson = Buffer.from('{"version":"1.0","truncation":null,"padding":null}');
    let fetchedUrl = "";
    setHfDownloadFn(async (url) => {
      fetchedUrl = url;
      return fakeJson;
    });
    resetHfTokenCounters();
    const counter = await getHfTokenCounter("meta-llama/Llama-3.1-8B", cacheDir);
    expect(fetchedUrl).toContain("huggingface.co");
    expect(counter).toBeNull();
    const cached = readFileSync(
      path.join(cacheDir, "meta-llama_Llama-3.1-8B", "tokenizer.json")
    );
    expect(cached.equals(fakeJson)).toBe(true);
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("stage1-r3-item5: cache hit keeps estimate source when HF unavailable", async () => {
    const tools = [FIXTURE_TOOL];
    const servers = [{ name: "s", status: "ok" as const }];
    const opts = {
      modelIds: ["llama-3.1-8b"],
      countMode: "offline" as const,
    };
    const first = await analyzeToolsAsync(tools, servers, opts);
    expect(first.tokenCountsByModel?.["llama-3.1-8b"]?.source).toBe("estimate");
    const second = await analyzeToolsAsync(tools, servers, opts);
    expect(second.tokenCountsByModel?.["llama-3.1-8b"]?.source).toBe("estimate");

    resetCountMemo();
    const withFixture = await analyzeToolsAsync(tools, servers, {
      modelIds: ["llama-hf-fixture"],
      countMode: "offline",
    });
    expect(withFixture.tokenCountsByModel?.["llama-hf-fixture"]?.source).toBe(
      "exact-offline"
    );
    const again = await analyzeToolsAsync(tools, servers, {
      modelIds: ["llama-hf-fixture"],
      countMode: "offline",
    });
    expect(again.tokenCountsByModel?.["llama-hf-fixture"]?.source).toBe(
      "exact-offline"
    );
  });

  it("stage1-r3-item6: POST /api/model-counts rejects JSON null body with 400", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "r3-null-body-"));
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
    const origin = serverOrigin(server);
    const res = await fetch(`${origin}/api/model-counts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Auth-Token": server.token,
      },
      body: "null",
    });
    expect(res.status).toBe(400);
    await server.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("stage1-r3-item7a: CLI rejects bogus --count-mode with exit 2", () => {
    try {
      execSync(
        `node "${cliPath}" analyze --tools-json "${tinyPath}" --count-mode nonsense`,
        { encoding: "utf8", cwd: path.join(__dirname, "..") }
      );
      expect.fail("should exit");
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: string; stdout?: string };
      expect(e.status).toBe(2);
      expect(String(e.stderr ?? e.stdout)).toMatch(/count-mode/i);
    }
  });

  it("stage1-r3-item7b: CLI rejects invalid --framing with exit 2", () => {
    try {
      execSync(
        `node "${cliPath}" analyze --tools-json "${tinyPath}" --framing nonsense`,
        { encoding: "utf8", cwd: path.join(__dirname, "..") }
      );
      expect.fail("should exit");
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: string };
      expect(e.status).toBe(2);
      expect(String(e.stderr)).toMatch(/framing/i);
    }
  });

  it("stage1-r3-item7c: CLI rejects unknown --model with exit 2", () => {
    try {
      execSync(
        `node "${cliPath}" analyze --tools-json "${tinyPath}" --model not-a-real-model`,
        { encoding: "utf8", cwd: path.join(__dirname, "..") }
      );
      expect.fail("should exit");
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: string };
      expect(e.status).toBe(2);
      expect(String(e.stderr)).toMatch(/unknown/i);
    }
  });

  it("stage1-r3-item7d: CLI rejects more than 8 extra --models with exit 2", () => {
    const extras = Array.from({ length: 9 }, (_, i) => `gpt-4o`).join(",");
    try {
      execSync(
        `node "${cliPath}" analyze --tools-json "${tinyPath}" --models "${extras}"`,
        { encoding: "utf8", cwd: path.join(__dirname, "..") }
      );
      expect.fail("should exit");
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: string };
      expect(e.status).toBe(2);
      expect(String(e.stderr)).toMatch(/max 8/i);
    }
  });

  it("stage1-r3-item7e: API rejects invalid countMode with 400", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "r3-api-mode-"));
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
      modelIds: ["gpt-4o"],
      countMode: "nonsense",
    });
    expect(res.status).toBe(400);
    await server.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("stage1-r3-item7f: API rejects unknown primaryModelId with 400", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "r3-api-primary-"));
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
      modelIds: ["gpt-4o"],
      primaryModelId: "not-a-real-model",
    });
    expect(res.status).toBe(400);
    await server.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("stage1-r3-item8a: --verbose prints one HF line with npm peer hint", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setMeterVerbose(true);
    resetHfTokenCounters();
    setHfPeerInstalledCheck(async () => false);
    await getHfTokenCounter("meta-llama/Llama-3.1-8B", path.join(tmpdir(), "no-cache-peer"));
    const lines = errSpy.mock.calls.map((c) => String(c[0]));
    const hfLines = lines.filter((l) => l.includes("HF tokenizer"));
    expect(hfLines.length).toBe(1);
    expect(hfLines[0]).toMatch(/peer not installed|@huggingface\/tokenizers/);
    errSpy.mockRestore();
    setMeterVerbose(false);
  });

  it("stage1-r3-item8b: auto mode logs api fallback reason when keys missing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setMeterVerbose(true);
    await analyzeToolsAsync([FIXTURE_TOOL], [{ name: "s", status: "ok" }], {
      modelIds: ["claude-sonnet-4-5"],
      countMode: "auto",
      verbose: true,
    });
    const joined = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toMatch(/ANTHROPIC_API_KEY not set/);
    errSpy.mockRestore();
    setMeterVerbose(false);
  });

  it("stage1-r3-item8c: doctor reports HF peer install state", () => {
    const out = execSync(`node "${cliPath}" doctor`, {
      encoding: "utf8",
      cwd: path.join(__dirname, ".."),
    });
    expect(out).toMatch(/@huggingface\/tokenizers peer:/);
  });

  it("stage1-r3-item9a: analyze text prints Per-model section once", () => {
    const output = execSync(
      `node "${cliPath}" analyze --tools-json "${bloatedPath}" --model gpt-4o --models claude-sonnet-4-5`,
      { encoding: "utf8", cwd: path.join(__dirname, "..") }
    );
    const count = output.split("Per-model token totals:").length - 1;
    expect(count).toBe(1);
  });

  it("stage1-r3-item9b: exact per-model totals omit tilde in text report", async () => {
    const { servers, tools } = await loadToolsJson(tinyPath);
    const report = await analyzeToolsAsync(tools, servers, {
      modelIds: ["openai:o200k"],
      countMode: "offline",
    });
    const text = formatTextReport(report);
    expect(text).toMatch(/openai:o200k: ~\d+ tokens \(estimate/);
  });

  it("stage1-r3-item9c: openai:o200k total matches legacy ranked column", async () => {
    const { servers, tools } = await loadToolsJson(tinyPath);
    const report = await analyzeToolsAsync(tools, servers, {
      modelIds: ["openai:o200k"],
      countMode: "offline",
    });
    expect(report.tokenCountsByModel?.["openai:o200k"]?.total).toBe(
      report.totals.estTokens
    );
  });

  it("stage1-r3-item9d: llama-hf-fixture hidden from UI presets unless test env", () => {
    const prev = process.env.TOOL_TOKEN_BUDGET_EXPOSE_TEST_MODELS;
    delete process.env.TOOL_TOKEN_BUDGET_EXPOSE_TEST_MODELS;
    const prevNode = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const ids = listPresetModelsForUi().map((m) => m.id);
    expect(ids).not.toContain("llama-hf-fixture");
    process.env.TOOL_TOKEN_BUDGET_EXPOSE_TEST_MODELS = "1";
    expect(listPresetModelsForUi().map((m) => m.id)).toContain("llama-hf-fixture");
    if (prev !== undefined) {
      process.env.TOOL_TOKEN_BUDGET_EXPOSE_TEST_MODELS = prev;
    } else {
      delete process.env.TOOL_TOKEN_BUDGET_EXPOSE_TEST_MODELS;
    }
    process.env.NODE_ENV = prevNode;
  });
});

function resetHfTokenizers(): void {
  resetHfTokenCounters();
}
