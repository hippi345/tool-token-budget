import type { Tool, ToolMeter } from "../types.js";
import { estimateTokens } from "./tokenize.js";

export { estimateTokens };

/** Meter a single tool: name + description + stringified schema. */
export function meterTool(tool: Tool): ToolMeter {
  const nameTokens = estimateTokens(tool.name);
  const descTokens = estimateTokens(tool.description ?? "");
  const schemaJson = JSON.stringify(tool.inputSchema ?? {});
  const schemaTokens = estimateTokens(schemaJson);
  return {
    server: tool.server,
    name: tool.name,
    estTokens: nameTokens + descTokens + schemaTokens,
    breakdown: {
      name: nameTokens,
      description: descTokens,
      schema: schemaTokens,
    },
    shareOfServer: 0,
    shareOfAll: 0,
  };
}

/** Sort meters by estTokens descending (copy). */
export function rankTools(meters: ToolMeter[]): ToolMeter[] {
  return [...meters].sort((a, b) => b.estTokens - a.estTokens);
}

/** Attach shareOfServer and shareOfAll fractions (0–1). */
export function attachShares(meters: ToolMeter[]): ToolMeter[] {
  const totalAll = meters.reduce((s, m) => s + m.estTokens, 0);
  const byServer = new Map<string, number>();
  for (const m of meters) {
    byServer.set(m.server, (byServer.get(m.server) ?? 0) + m.estTokens);
  }
  return meters.map((m) => {
    const serverTotal = byServer.get(m.server) ?? 0;
    return {
      ...m,
      shareOfServer: serverTotal > 0 ? m.estTokens / serverTotal : 0,
      shareOfAll: totalAll > 0 ? m.estTokens / totalAll : 0,
    };
  });
}
