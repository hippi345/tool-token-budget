/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { buildModelSelectOptions } from "../gui/src/modelPresetOptions.js";
import {
  isValidPrimaryModelId,
  resolvePrimaryModelId,
} from "../gui/src/primaryModel.js";
import {
  isUnknownPrimaryModelCountsError,
  modelCountsLoadErrorMessage,
} from "../gui/src/modelCountsErrors.js";
import { ModelCountsHttpError } from "../gui/src/api.js";
import { useModelCounts } from "../gui/src/useModelCounts.js";
import * as api from "../gui/src/api.js";

const SAMPLE_PRESETS = [
  { id: "gpt-4o" },
  { id: "claude-sonnet-4-5" },
  { id: "cursor-dynamic", experimental: true },
];

describe("Stage 1 review round 5", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stage1-r5-item1a: resolvePrimaryModelId rejects unknown saved id", () => {
    expect(resolvePrimaryModelId("not-a-real-model", SAMPLE_PRESETS)).toBe(
      "openai:o200k"
    );
    expect(resolvePrimaryModelId("gpt-4o", SAMPLE_PRESETS)).toBe("gpt-4o");
    expect(resolvePrimaryModelId(null, SAMPLE_PRESETS)).toBe("openai:o200k");
  });

  it("stage1-r5-item1b: buildModelSelectOptions omits invalid primary when presets loaded", () => {
    const opts = buildModelSelectOptions(SAMPLE_PRESETS, "not-a-real-model");
    const ids = opts.map((o) => o.id);
    expect(ids).not.toContain("not-a-real-model");
    expect(ids).toContain("openai:o200k");
    expect(isValidPrimaryModelId("not-a-real-model", SAMPLE_PRESETS)).toBe(false);
  });

  it("stage1-r5-item1c: unknown model 400 is detected for primary fallback", () => {
    expect(
      isUnknownPrimaryModelCountsError(
        400,
        JSON.stringify({ error: "unknown or invalid primaryModelId" })
      )
    ).toBe(true);
    expect(
      isUnknownPrimaryModelCountsError(400, JSON.stringify({ error: "unknown model id: foo" }))
    ).toBe(true);
    expect(isUnknownPrimaryModelCountsError(500, "Model count failed")).toBe(false);
  });

  it("stage1-r5-item2a: modelCountsLoadErrorMessage formats HTTP failures", () => {
    const err = new ModelCountsHttpError(503, '{"error":"Tools not yet available"}');
    expect(modelCountsLoadErrorMessage(err)).toBe(
      `Couldn't load model counts: {"error":"Tools not yet available"}`
    );
  });

  it("stage1-r5-item2b: useModelCounts surfaces loadError on non-400 failures", async () => {
    vi.spyOn(api, "postModelCounts").mockRejectedValue(
      new ModelCountsHttpError(503, "service unavailable")
    );

    const { result } = renderHook(() =>
      useModelCounts(["gpt-4o"], "gpt-4o", "offline")
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.loadError).toMatch(/Couldn't load model counts/);
    expect(result.current.loadError).toContain("service unavailable");
    expect(result.current.tokenCountsByModel).toEqual({});
  });

  it("stage1-r5-item2c: useModelCounts clears loadError after successful fetch", async () => {
    const mock = vi.spyOn(api, "postModelCounts");
    mock.mockRejectedValueOnce(new ModelCountsHttpError(500, "boom"));
    mock.mockImplementation(async (body) => ({
      tokenCountsByModel: {
        [body.primaryModelId ?? "gpt-4o"]: { total: 42, source: "estimate" },
      },
      tools: [],
    }));

    const { result, rerender } = renderHook(
      ({ modelId }) => useModelCounts([modelId], modelId, "offline"),
      { initialProps: { modelId: "gpt-4o" } }
    );

    await waitFor(() => {
      expect(result.current.loadError).toMatch(/Couldn't load model counts/);
    });

    rerender({ modelId: "claude-sonnet-4-5" });

    await waitFor(() => {
      expect(result.current.loadError).toBeNull();
      expect(result.current.tokenCountsByModel["claude-sonnet-4-5"]?.total).toBe(42);
    });
  });
});
