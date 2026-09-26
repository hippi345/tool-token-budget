import type { AnalyzeHistoryEntry } from "./types.js";
import { sparkline } from "./sparkline.js";

export interface HistoryFilter {
  client?: string;
  model?: string;
  since?: string;
  limit?: number;
}

export function filterHistoryEntries(
  entries: AnalyzeHistoryEntry[],
  filter: HistoryFilter
): AnalyzeHistoryEntry[] {
  let out = [...entries];
  if (filter.since) {
    const sinceMs = Date.parse(filter.since);
    if (!Number.isNaN(sinceMs)) {
      out = out.filter((e) => Date.parse(e.at) >= sinceMs);
    }
  }
  if (filter.client) {
    out = out.filter((e) => e.byClient[filter.client!] !== undefined);
  }
  if (filter.model) {
    out = out.filter((e) => e.byModel[filter.model!] !== undefined);
  }
  if (filter.limit !== undefined && filter.limit > 0) {
    out = out.slice(-filter.limit);
  }
  return out;
}

function seriesForClients(entries: AnalyzeHistoryEntry[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const e of entries) {
    for (const [clientId, tokens] of Object.entries(e.byClient)) {
      const arr = map.get(clientId) ?? [];
      arr.push(tokens);
      map.set(clientId, arr);
    }
  }
  return map;
}

function seriesForModels(entries: AnalyzeHistoryEntry[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const e of entries) {
    for (const [modelId, tokens] of Object.entries(e.byModel)) {
      const arr = map.get(modelId) ?? [];
      arr.push(tokens);
      map.set(modelId, arr);
    }
  }
  return map;
}

export function formatHistoryText(
  entries: AnalyzeHistoryEntry[],
  filter: HistoryFilter
): string {
  const filtered = filterHistoryEntries(entries, filter);
  if (filtered.length === 0) {
    return "No analyze history yet. Run `tool-token-budget analyze` to record totals.";
  }

  const lines: string[] = ["tool-token-budget analyze history", ""];
  const totals = filtered.map((e) => e.totalTokens);
  lines.push(`totals  ${sparkline(totals)}  (${totals.at(-1)} latest, n=${totals.length})`);

  const clients = seriesForClients(filtered);
  if (clients.size > 0) {
    lines.push("");
    lines.push("by client:");
    for (const [id, series] of [...clients.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`  ${id.padEnd(20)} ${sparkline(series)}  (${series.at(-1)} latest)`);
    }
  }

  const models = seriesForModels(filtered);
  if (models.size > 0) {
    lines.push("");
    lines.push("by model:");
    for (const [id, series] of [...models.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`  ${id.padEnd(28)} ${sparkline(series)}  (${series.at(-1)} latest)`);
    }
  }

  return lines.join("\n");
}

export interface HistoryJsonPayload {
  entries: AnalyzeHistoryEntry[];
  sparklines: {
    totals: string;
    byClient: Record<string, string>;
    byModel: Record<string, string>;
  };
}

export function formatHistoryJson(
  entries: AnalyzeHistoryEntry[],
  filter: HistoryFilter
): HistoryJsonPayload {
  const filtered = filterHistoryEntries(entries, filter);
  const totals = filtered.map((e) => e.totalTokens);
  const byClient = seriesForClients(filtered);
  const byModel = seriesForModels(filtered);
  const sparklines = {
    totals: sparkline(totals),
    byClient: Object.fromEntries(
      [...byClient.entries()].map(([k, v]) => [k, sparkline(v)])
    ),
    byModel: Object.fromEntries(
      [...byModel.entries()].map(([k, v]) => [k, sparkline(v)])
    ),
  };
  return { entries: filtered, sparklines };
}
