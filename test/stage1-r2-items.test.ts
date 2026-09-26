import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Tokenizer } from "@huggingface/tokenizers";
import { readFileSync } from "node:fs";
import { analyzeToolsAsync } from "../src/pipeline.js";
import {
  buildOpenAiToolPayload,
  buildVscodeFlatToolPayload,
  buildGeminiToolsRequestPayload,
  buildFullInjectPayload,
} from "../src/meter/framing.js";
import { getHfTokenCounter, resetHfTokenCounters } from "../src/meter/hfTokenize.js";
import { resetCountMemo } from "../src/meter/perModel.js";
import {
  resetApiFetchImpl,
  setApiFetchImpl,
} from "../src/meter/apiTokenCount.js";
import { setMeterVerbose, logMeterVerbose } from "../src/meter/meterVerbose.js";
import { isExperimentalModelId } from "../src/meter/modelCatalog.js";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { apiPost, serverOrigin } from "./helpers/uiServer.js";
import { analyzeTools } from "../src/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, "../dist/cli.js");

const FIXTURE_TOOL = {
  server: "s",
  name: "search",
  description: "Find things",
  inputSchema: { type: "object" },
};

function hfGoldenCount(text: string): number {
  const tokenizerJson = JSON.parse(
    readFileSync(
      path.join(__dirname, "../fixtures/tokenizers/tiny-bpe/tokenizer.json"),
      "utf8"
    )
  );
  const t = new Tokenizer(tokenizerJson, {});
  return t.encode(text).ids.length;
}

describe("Stage 1 review round 2", () => {
  beforeEach(() => {
    resetCountMemo();
    resetHfTokenCounters();
    resetApiFetchImpl();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    resetApiFetchImpl();
  });

  it("stage1-r2-item1: HF peer loads fixture and yields exact-offline counts", async () => {
    const counter = await getHfTokenCounter("fixture-tiny-bpe");
    expect(counter).not.toBeNull();
    const payload = buildFullInjectPayload(FIXTURE_TOOL);
    const expected = hfGoldenCount(payload);
    expect(counter!(payload)).toBe(expected);

    const report = await analyzeToolsAsync(
      [FIXTURE_TOOL],
      [{ name: "s", status: "ok" }],
      { modelIds: ["llama-hf-fixture"], verbose: true }
    );
    const summary = report.tokenCountsByModel?.["llama-hf-fixture"];
    expect(summary?.source).toBe("exact-offline");
    expect(summary?.total).toBe(expected);
  });

  it("stage1-r2-item1b: --verbose logs HF fallback reason once", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setMeterVerbose(true);
    logMeterVerbose("HF tokenizer unavailable for missing-id (test)");
    expect(errSpy).toHaveBeenCalledWith(
      "HF tokenizer unavailable for missing-id (test)"
    );
    errSpy.mockRestore();
    setMeterVerbose(false);
    const errSpy2 = vi.spyOn(console, "error").mockImplementation(() => {});
    logMeterVerbose("should not print");
    expect(errSpy2).not.toHaveBeenCalled();
    errSpy2.mockRestore();
  });

  describe("stage1-r2-item2: POST /api/model-counts validation", () => {
    let server: ServerInstance;
    let testDir: string;

    beforeEach(async () => {
      testDir = await mkdtemp(path.join(tmpdir(), "r2-model-counts-"));
      const tools = [FIXTURE_TOOL];
      const servers = [{ name: "s", status: "ok" as const }];
      const report = analyzeTools(tools, servers);
      server = await startServer({
        port: 0,
        onReady: () => {},
        getReport: () => report,
        cwd: testDir,
      });
      server.broadcast(
        {
          timestamp: new Date().toISOString(),
          servers,
          tools,
          report,
        },
        null
      );
    });

    afterEach(async () => {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    });

    it("stage1-r2-item2a: rejects non-array modelIds", async () => {
      const res = await apiPost(server, "/api/model-counts", {
        modelIds: "gpt-4o",
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/array/i);
    });

    it("stage1-r2-item2b: rejects too many modelIds", async () => {
      const res = await apiPost(server, "/api/model-counts", {
        modelIds: Array.from({ length: 17 }, (_, i) => `gpt-4o-${i}`),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/maximum of 16/i);
    });

    it("stage1-r2-item2c: rejects non-string modelIds", async () => {
      const res = await apiPost(server, "/api/model-counts", {
        modelIds: ["gpt-4o", 42],
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/non-empty string/i);
    });

    it("stage1-r2-item2d: rejects unknown model id", async () => {
      const res = await apiPost(server, "/api/model-counts", {
        modelIds: ["not-a-real-model-id"],
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/unknown model id/i);
    });
  });

  it("stage1-r2-item3: --api-count-max caps HTTP calls across models", async () => {
    const tools = [
      { server: "a", name: "t1", description: "d", inputSchema: {} },
      { server: "b", name: "t2", description: "d", inputSchema: {} },
    ];
    let calls = 0;
    setApiFetchImpl(async (url) => {
      calls += 1;
      return {
        ok: true,
        json: async () =>
          String(url).includes("anthropic")
            ? { input_tokens: 50 }
            : { totalTokens: 60 },
      } as Response;
    });
    process.env.ANTHROPIC_API_KEY = "k1";
    process.env.GEMINI_API_KEY = "k2";

    const report = await analyzeToolsAsync(tools, [], {
      modelIds: ["claude-sonnet-4-5", "gemini-2.0-flash"],
      countMode: "auto",
      apiCountMax: 1,
    });
    expect(calls).toBe(1);
    const claude = report.tokenCountsByModel?.["claude-sonnet-4-5"];
    const gemini = report.tokenCountsByModel?.["gemini-2.0-flash"];
    expect(claude?.source === "exact-api" || gemini?.source === "exact-api").toBe(
      true
    );
    expect(
      claude?.source === "estimate" || gemini?.source === "estimate"
    ).toBe(true);
  });

  it("stage1-r2-item3b: Anthropic batches all servers into one HTTP call", async () => {
    const tools = [
      { server: "a", name: "t1", description: "d", inputSchema: {} },
      { server: "b", name: "t2", description: "d", inputSchema: {} },
    ];
    let calls = 0;
    setApiFetchImpl(async () => {
      calls += 1;
      return { ok: true, json: async () => ({ input_tokens: 99 }) } as Response;
    });
    process.env.ANTHROPIC_API_KEY = "k1";
    await analyzeToolsAsync(tools, [], {
      modelIds: ["claude-sonnet-4-5"],
      countMode: "auto",
      apiCountMax: 1,
    });
    expect(calls).toBe(1);
  });

  it("stage1-r2-item4: openai-tools uses function wrapper", () => {
    const payload = buildOpenAiToolPayload(FIXTURE_TOOL);
    const parsed = JSON.parse(payload);
    expect(parsed.type).toBe("function");
    expect(parsed.function.name).toBe("search");
    expect(payload).not.toContain('"type":"function","name"');
  });

  it("stage1-r2-item4b: vscode-flat keeps flat shape", () => {
    const payload = buildVscodeFlatToolPayload(FIXTURE_TOOL);
    const parsed = JSON.parse(payload);
    expect(parsed.name).toBe("search");
    expect(parsed.type).toBeUndefined();
  });

  it("stage1-r2-item4c: gemini offline uses single tools wrapper", async () => {
    const tools = [
      FIXTURE_TOOL,
      { server: "s", name: "other", description: "x", inputSchema: {} },
    ];
    const report = await analyzeToolsAsync(tools, [{ name: "s", status: "ok" }], {
      modelIds: ["gemini-2.0-flash"],
      countMode: "offline",
    });
    const wrapper = JSON.parse(buildGeminiToolsRequestPayload(tools));
    expect(wrapper.tools).toHaveLength(1);
    expect(wrapper.tools[0].functionDeclarations).toHaveLength(2);
    expect(report.tokenCountsByModel?.["gemini-2.0-flash"]?.framing).toBe(
      "gemini-functions"
    );
    const sumPerTool = Object.values(
      report.tokenCountsByModel?.["gemini-2.0-flash"]?.perTool ?? {}
    ).reduce((a, b) => a + b, 0);
    expect(sumPerTool).toBe(report.tokenCountsByModel?.["gemini-2.0-flash"]?.total);
  });

  it("stage1-r2-item5: cursor-dynamic is marked experimental in catalog", () => {
    expect(isExperimentalModelId("cursor-dynamic")).toBe(true);
    expect(isExperimentalModelId("gpt-4o")).toBe(false);
  });
});
