import type { Tool } from "../types.js";
import { buildCursorCatalogPayload } from "./framing.js";
import { hashSchema } from "./schemaHash.js";
import { incrementCatalogTokenizerCallCount } from "./catalogCountMetrics.js";

/** Stable fingerprint of the tool list for cursor-catalog cache keys. */
export function catalogContextKey(tools: Tool[]): string {
  const parts = tools.map(
    (t) => `${t.server}::${t.name}:${hashSchema(t.inputSchema)}`
  );
  parts.sort();
  return parts.join("|");
}

function toolKey(tool: Tool): string {
  return `${tool.server}::${tool.name}`;
}

/**
 * Count the shared cursor catalog payload once, then attribute each tool's
 * marginal token cost (full catalog minus catalog without that tool).
 * Integer marginals may sum below the catalog total; the gap is framingOverhead.
 */
export function attributeCursorCatalogTokens(
  tools: Tool[],
  countText: (text: string) => number
): { total: number; perTool: Record<string, number>; framingOverhead: number } {
  const perTool: Record<string, number> = {};
  if (tools.length === 0) {
    return { total: 0, perTool, framingOverhead: 0 };
  }

  const counted = (text: string) => {
    incrementCatalogTokenizerCallCount();
    return countText(text);
  };

  const fullText = buildCursorCatalogPayload(tools);
  const fullTokens = counted(fullText);

  if (tools.length === 1) {
    perTool[toolKey(tools[0])] = fullTokens;
    return { total: fullTokens, perTool, framingOverhead: 0 };
  }

  for (const tool of tools) {
    const rest = tools.filter(
      (t) => t.server !== tool.server || t.name !== tool.name
    );
    const withoutTokens = counted(buildCursorCatalogPayload(rest));
    perTool[toolKey(tool)] = Math.max(0, fullTokens - withoutTokens);
  }

  let marginalSum = Object.values(perTool).reduce((a, b) => a + b, 0);
  let framingOverhead = Math.max(0, fullTokens - marginalSum);

  if (marginalSum > fullTokens) {
    const scale = fullTokens / marginalSum;
    for (const key of Object.keys(perTool)) {
      perTool[key] = Math.floor(perTool[key] * scale);
    }
    marginalSum = Object.values(perTool).reduce((a, b) => a + b, 0);
    const remainder = fullTokens - marginalSum;
    if (remainder > 0 && tools.length > 0) {
      const firstKey = toolKey(tools[0]);
      perTool[firstKey] = (perTool[firstKey] ?? 0) + remainder;
      marginalSum += remainder;
    }
    framingOverhead = 0;
  }

  return { total: fullTokens, perTool, framingOverhead };
}
