import { describe, it, expect } from "vitest";
import { buildHistoryChartModel, yToPlot } from "../gui/src/historyChartLayout.js";

describe("stage3d history chart layout", () => {
  it("stage3d-history-chart-layout-multi-series-and-budget", () => {
    const entries = [
      {
        at: "2026-09-20T10:00:00.000Z",
        totalTokens: 100,
        byClient: { "cursor-global": 100, "windsurf": 80 },
        byModel: { "openai:o200k": 100 },
      },
      {
        at: "2026-09-21T10:00:00.000Z",
        totalTokens: 200,
        byClient: { "cursor-global": 200 },
        byModel: { "openai:o200k": 200 },
      },
    ];
    const model = buildHistoryChartModel(entries, {
      total: 500,
      clients: { "cursor-global": 150 },
    });
    expect(model.series.length).toBeGreaterThanOrEqual(2);
    expect(model.budgetLines.length).toBe(2);
    expect(model.xLabels.length).toBe(2);
  });

  it("stage3d-history-chart-normal-budget-scale", () => {
    const entries = [
      {
        at: "2026-09-20T10:00:00.000Z",
        totalTokens: 100,
        byClient: {},
        byModel: { "openai:o200k": 100 },
      },
      {
        at: "2026-09-21T10:00:00.000Z",
        totalTokens: 200,
        byClient: {},
        byModel: { "openai:o200k": 200 },
      },
    ];
    const model = buildHistoryChartModel(entries, { total: 150 });
    const budget = model.budgetLines.find((b) => b.id === "budget-total");
    expect(budget?.belowScale).toBeFalsy();
    const plotTop = 12;
    const plotHeight = 172;
    const yAtBudget = yToPlot(150, model.yMin, model.yMax, plotTop, plotHeight);
    const yAt200 = yToPlot(200, model.yMin, model.yMax, plotTop, plotHeight);
    expect(yAtBudget).toBeGreaterThan(yAt200);
  });

  it("stage3d-history-chart-tiny-budget-below-scale-label", () => {
    const entries = [
      {
        at: "2026-09-20T10:00:00.000Z",
        totalTokens: 500,
        byClient: {},
        byModel: { "openai:o200k": 500 },
      },
      {
        at: "2026-09-21T10:00:00.000Z",
        totalTokens: 600,
        byClient: {},
        byModel: { "openai:o200k": 600 },
      },
    ];
    const model = buildHistoryChartModel(entries, { total: 1 });
    const budget = model.budgetLines.find((b) => b.id === "budget-total");
    expect(budget?.belowScale).toBe(true);
    expect(model.yMin).toBeGreaterThan(1);
  });

  it("stage3d-history-chart-layout-single-entry", () => {
    const model = buildHistoryChartModel(
      [
        {
          at: "2026-09-22T12:00:00.000Z",
          totalTokens: 42,
          byClient: {},
          byModel: { "openai:o200k": 42 },
        },
      ],
      undefined
    );
    expect(model.entryCount).toBe(1);
    expect(model.series[0]?.points.length).toBe(1);
  });
});
