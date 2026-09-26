import { describe, it, expect } from "vitest";
import { formatSarif } from "../src/report/formatSarif.js";
import type { Report } from "../src/types.js";

describe("formatSarif", () => {
  it("should generate valid SARIF 2.1.0 JSON", () => {
    const report: Report = {
      generatedAt: "2026-09-23T00:00:00Z",
      tokenizerId: "o200k_base",
      totals: {
        estTokens: 1000,
        toolCount: 5,
        serverCount: 2,
        findingCount: 2,
      },
      tools: [],
      servers: [],
      findings: [
        {
          ruleId: "schema-too-large",
          severity: "warn",
          server: "test-server",
          tool: "test-tool",
          message: "Schema is too large",
          suggestion: "Simplify the schema",
        },
        {
          ruleId: "description-too-long",
          severity: "warn",
          server: "test-server",
          tool: "test-tool-2",
          message: "Description is too long",
        },
      ],
    };

    const sarif = formatSarif(report);
    const parsed = JSON.parse(sarif);

    expect(parsed.version).toBe("2.1.0");
    expect(parsed.$schema).toBe(
      "https://json.schemastore.org/sarif-2.1.0.json"
    );
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].tool.driver.name).toBe("tool-token-budget");
    expect(parsed.runs[0].tool.driver.informationUri).toBe(
      "https://github.com/hippi345/tool-token-budget"
    );
    expect(parsed.runs[0].results).toHaveLength(2);
    expect(parsed.runs[0].results[0].ruleId).toBe(
      "tool-token-budget/schema-too-large"
    );
    expect(parsed.runs[0].results[0].level).toBe("warning");
  });

  it("should include all standard rules in the driver", () => {
    const report: Report = {
      generatedAt: "2026-09-23T00:00:00Z",
      tokenizerId: "o200k_base",
      totals: {
        estTokens: 0,
        toolCount: 0,
        serverCount: 0,
        findingCount: 0,
      },
      tools: [],
      servers: [],
      findings: [],
    };

    const sarif = formatSarif(report);
    const parsed = JSON.parse(sarif);

    const ruleIds = parsed.runs[0].tool.driver.rules.map((r: any) => r.id);
    expect(ruleIds).toContain("tool-token-budget/description-too-long");
    expect(ruleIds).toContain("tool-token-budget/schema-too-large");
    expect(ruleIds).toContain("tool-token-budget/huge-enum");
    expect(ruleIds).toContain("tool-token-budget/deep-schema");
    expect(ruleIds).toContain(
      "tool-token-budget/duplicate-description-boilerplate"
    );
    expect(ruleIds).toContain("tool-token-budget/over-budget");
  });

  it("should map severity levels correctly", () => {
    const report: Report = {
      generatedAt: "2026-09-23T00:00:00Z",
      tokenizerId: "o200k_base",
      totals: {
        estTokens: 0,
        toolCount: 0,
        serverCount: 0,
        findingCount: 3,
      },
      tools: [],
      servers: [],
      findings: [
        {
          ruleId: "test-error",
          severity: "error",
          server: "s",
          tool: "t",
          message: "error message",
        },
        {
          ruleId: "test-warn",
          severity: "warn",
          server: "s",
          tool: "t",
          message: "warn message",
        },
        {
          ruleId: "test-info",
          severity: "info",
          server: "s",
          tool: "t",
          message: "info message",
        },
      ],
    };

    const sarif = formatSarif(report);
    const parsed = JSON.parse(sarif);

    expect(parsed.runs[0].results[0].level).toBe("error");
    expect(parsed.runs[0].results[1].level).toBe("warning");
    expect(parsed.runs[0].results[2].level).toBe("note");
  });

  it("should include totals and savings in properties", () => {
    const report: Report = {
      generatedAt: "2026-09-23T00:00:00Z",
      tokenizerId: "o200k_base",
      totals: {
        estTokens: 1000,
        toolCount: 5,
        serverCount: 2,
        findingCount: 0,
      },
      tools: [],
      servers: [],
      findings: [],
      savings: {
        currentEstTokens: 1000,
        proposedEstTokens: 100,
        savedEstTokens: 900,
        savedPct: 90,
      },
    };

    const sarif = formatSarif(report);
    const parsed = JSON.parse(sarif);

    expect(parsed.runs[0].properties.totals).toEqual(report.totals);
    expect(parsed.runs[0].properties.savings).toEqual(report.savings);
  });
});
