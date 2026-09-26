import { describe, it, expect } from "vitest";
import { formatHtml } from "../src/report/formatHtml.js";
import type { Report } from "../src/types.js";

describe("formatHtml - polished", () => {
  it("should include savings banner when savings are present", () => {
    const report: Report = {
      generatedAt: "2026-09-23T00:00:00Z",
      tokenizerId: "o200k_base",
      totals: {
        estTokens: 1000,
        toolCount: 5,
        serverCount: 2,
        findingCount: 0,
      },
      tools: [
        {
          server: "test-server",
          name: "test-tool",
          estTokens: 500,
          breakdown: { name: 10, description: 20, schema: 470 },
          shareOfServer: 0.5,
          shareOfAll: 0.5,
        },
      ],
      servers: [],
      findings: [],
      savings: {
        currentEstTokens: 1000,
        proposedEstTokens: 100,
        savedEstTokens: 900,
        savedPct: 90,
      },
    };

    const html = formatHtml(report);

    expect(html).toContain("Estimated Savings");
    expect(html).toContain("~1000 tokens");
    expect(html).toContain("~100 tokens");
    expect(html).toContain("~900 tokens");
    expect(html).toContain("90%");
    expect(html).toContain("mcp.json.tool-token-budget-proposed.json");
  });

  it("should not include savings banner when savings are absent", () => {
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
    };

    const html = formatHtml(report);

    expect(html).not.toContain("Estimated Savings");
  });

  it("should include top offenders table with lint hits", () => {
    const report: Report = {
      generatedAt: "2026-09-23T00:00:00Z",
      tokenizerId: "o200k_base",
      totals: {
        estTokens: 1500,
        toolCount: 3,
        serverCount: 1,
        findingCount: 2,
      },
      tools: [
        {
          server: "server-a",
          name: "tool-1",
          estTokens: 800,
          breakdown: { name: 10, description: 100, schema: 690 },
          shareOfServer: 0.5,
          shareOfAll: 0.5,
        },
        {
          server: "server-a",
          name: "tool-2",
          estTokens: 500,
          breakdown: { name: 10, description: 50, schema: 440 },
          shareOfServer: 0.3,
          shareOfAll: 0.3,
        },
        {
          server: "server-a",
          name: "tool-3",
          estTokens: 200,
          breakdown: { name: 10, description: 20, schema: 170 },
          shareOfServer: 0.2,
          shareOfAll: 0.2,
        },
      ],
      servers: [],
      findings: [
        {
          ruleId: "schema-too-large",
          severity: "warn",
          server: "server-a",
          tool: "tool-1",
          message: "Schema is too large",
        },
        {
          ruleId: "description-too-long",
          severity: "warn",
          server: "server-a",
          tool: "tool-1",
          message: "Description is too long",
        },
      ],
    };

    const html = formatHtml(report);

    expect(html).toContain("Top Token Offenders");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<td>server-a</td>");
    expect(html).toContain("<td>tool-1</td>");
    expect(html).toContain("<td>800</td>");
    expect(html).toContain("<td>2</td>"); // 2 lint hits for tool-1
  });

  it("should escape HTML in tool names and messages", () => {
    const report: Report = {
      generatedAt: "2026-09-23T00:00:00Z",
      tokenizerId: "o200k_base",
      totals: {
        estTokens: 100,
        toolCount: 1,
        serverCount: 1,
        findingCount: 1,
      },
      tools: [
        {
          server: "server<script>",
          name: "tool&test",
          estTokens: 100,
          breakdown: { name: 10, description: 20, schema: 70 },
          shareOfServer: 1,
          shareOfAll: 1,
        },
      ],
      servers: [],
      findings: [
        {
          ruleId: "test",
          severity: "warn",
          server: "server<script>",
          tool: "tool&test",
          message: "Message with <html>",
        },
      ],
    };

    const html = formatHtml(report);

    expect(html).toContain("server&lt;script&gt;");
    expect(html).toContain("tool&amp;test");
    expect(html).toContain("Message with &lt;html&gt;");
    expect(html).not.toContain("<script>");
  });

  it("should include suggestions in findings when present", () => {
    const report: Report = {
      generatedAt: "2026-09-23T00:00:00Z",
      tokenizerId: "o200k_base",
      totals: {
        estTokens: 100,
        toolCount: 1,
        serverCount: 1,
        findingCount: 1,
      },
      tools: [],
      servers: [],
      findings: [
        {
          ruleId: "test",
          severity: "warn",
          server: "s",
          tool: "t",
          message: "Problem found",
          suggestion: "Try this fix",
        },
      ],
    };

    const html = formatHtml(report);

    expect(html).toContain("Problem found");
    expect(html).toContain("Try this fix");
  });
});
