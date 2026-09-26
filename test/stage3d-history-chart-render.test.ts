/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { render, waitFor } from "@testing-library/react";
import { HistoryChart } from "../gui/src/HistoryChart.js";

describe("stage3d history chart render", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("stage3d-history-chart-budget-line-dash-attribute", async () => {
    const entries = [
      {
        at: "2026-09-20T10:00:00.000Z",
        totalTokens: 200,
        byClient: {},
        byModel: { "openai:o200k": 200 },
      },
    ];
    const budget = { total: 150 };

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/analyze-history")) {
        return new Response(JSON.stringify({ entries, budget, corrupt: false }), {
          status: 200,
        });
      }
      return originalFetch(input);
    };

    const { container } = render(createElement(HistoryChart));

    await waitFor(() => {
      const lines = container.querySelectorAll('[data-testid="history-budget-line"]');
      expect(lines.length).toBeGreaterThan(0);
    });

    const lines = container.querySelectorAll('[data-testid="history-budget-line"]');
    for (const line of lines) {
      expect(line.getAttribute("stroke-dasharray")).toBe("6 4");
    }
  });
});
