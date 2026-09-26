import type { Report } from "../types.js";
import { SARIF_TOOL_NAME, sarifRuleId } from "../branding/artifactPaths.js";

/**
 * Format report as SARIF 2.1.0 for GitHub Code Scanning / CI integration.
 * Maps lint findings to SARIF results with stable rule IDs.
 */
export function formatSarif(report: Report): string {
  const rules = [
    {
      id: sarifRuleId("description-too-long"),
      shortDescription: { text: "Tool description exceeds recommended length" },
      help: {
        text: "Long descriptions consume excessive tokens. Consider condensing to < 500 chars.",
      },
      defaultConfiguration: { level: "warning" },
    },
    {
      id: sarifRuleId("schema-too-large"),
      shortDescription: { text: "Tool schema is too large" },
      help: {
        text: "Large schemas consume excessive tokens. Consider simplifying or splitting the tool.",
      },
      defaultConfiguration: { level: "warning" },
    },
    {
      id: sarifRuleId("huge-enum"),
      shortDescription: { text: "Enum with excessive values" },
      help: {
        text: "Large enums consume excessive tokens. Consider reducing or using a different validation approach.",
      },
      defaultConfiguration: { level: "warning" },
    },
    {
      id: sarifRuleId("deep-schema"),
      shortDescription: { text: "Schema nesting is too deep" },
      help: {
        text: "Deep schema nesting can be hard to understand. Consider flattening the structure.",
      },
      defaultConfiguration: { level: "note" },
    },
    {
      id: sarifRuleId("duplicate-description-boilerplate"),
      shortDescription: { text: "Duplicate description text across tools" },
      help: {
        text: "Identical descriptions suggest copy-paste boilerplate. Each tool should have a unique description.",
      },
      defaultConfiguration: { level: "note" },
    },
    {
      id: sarifRuleId("over-budget"),
      shortDescription: { text: "Total token budget exceeded" },
      help: {
        text: "The total estimated token count exceeds the configured budget.",
      },
      defaultConfiguration: { level: "error" },
    },
  ];

  const results = report.findings.map((f) => {
    const ruleId = sarifRuleId(f.ruleId);
    const level = severityToSarifLevel(f.severity);
    return {
      ruleId,
      level,
      message: {
        text: f.message,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: "mcp.json",
              uriBaseId: "%SRCROOT%",
            },
            region: {
              startLine: 1,
              startColumn: 1,
            },
          },
          logicalLocations: [
            {
              name: `${f.server}::${f.tool}`,
              kind: "resource",
            },
          ],
        },
      ],
      properties: {
        server: f.server,
        tool: f.tool,
        suggestion: f.suggestion,
      },
    };
  });

  const sarif = {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: SARIF_TOOL_NAME,
            version: "1.0.0",
            informationUri: "https://github.com/hippi345/tool-token-budget",
            rules,
          },
        },
        results,
        properties: {
          totals: report.totals,
          savings: report.savings,
        },
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

function severityToSarifLevel(severity: "info" | "warn" | "error"): string {
  switch (severity) {
    case "error":
      return "error";
    case "warn":
      return "warning";
    case "info":
      return "note";
  }
}
