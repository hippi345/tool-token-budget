import { describe, it, expect } from "vitest";
import { estimateTokens, meterTool, rankTools } from "../src/meter/score.js";

describe("estimateTokens", () => {
  it("is stable and positive for a fixed string", () => {
    const a = estimateTokens("hello schema-budget");
    const b = estimateTokens("hello schema-budget");
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });
});

describe("meterTool", () => {
  it("breaks down name/description/schema and sums them", () => {
    const meter = meterTool({
      server: "demo",
      name: "search",
      description: "Find things",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    });
    expect(meter.estTokens).toBe(
      meter.breakdown.name + meter.breakdown.description + meter.breakdown.schema
    );
    expect(meter.breakdown.schema).toBeGreaterThan(0);
  });
});

describe("rankTools", () => {
  it("sorts by estTokens descending", () => {
    const ranked = rankTools([
      { server: "a", name: "small", estTokens: 10, breakdown: { name: 1, description: 1, schema: 8 }, shareOfServer: 0, shareOfAll: 0 },
      { server: "a", name: "big", estTokens: 100, breakdown: { name: 1, description: 1, schema: 98 }, shareOfServer: 0, shareOfAll: 0 },
    ]);
    expect(ranked[0].name).toBe("big");
    expect(ranked[1].name).toBe("small");
  });
});
