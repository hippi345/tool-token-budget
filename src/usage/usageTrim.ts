import type { Report, ToolMeter, PolicyOptions, SavingsSummary, ToolUsageRow } from "../types.js";
import type { UsageScanResult } from "./collectUsage.js";
import { countForTool } from "./collectUsage.js";
import { toolKey, selectHotToolsWithPolicy } from "../emit/keepHot.js";

export function buildUsageRows(report: Report, scan: UsageScanResult): ToolUsageRow[] {
  return report.tools.map((m) => {
    const callCount = countForTool(scan.counts, m.server, m.name);
    return {
      server: m.server,
      tool: m.name,
      callCount,
      used: callCount > 0,
      estTokens: m.estTokens,
    };
  });
}

export function hasUsageSignal(scan: UsageScanResult): boolean {
  if (Object.keys(scan.counts).length > 0) {
    return true;
  }
  return scan.clients.some((c) => c.scannedPaths.length > 0);
}

export function plainNoLogsMessage(scan: UsageScanResult): string | undefined {
  const allMissing = scan.clients.every((c) => c.status === "missing");
  if (allMissing) {
    return "No client tool-call logs found (Claude Code, Codex, and Cursor directories are all missing). Usage-aware trim skipped.";
  }
  const noCounts = Object.keys(scan.counts).length === 0;
  const noFiles = scan.clients.every((c) => c.scannedPaths.length === 0);
  if (noCounts && noFiles) {
    return "No MCP tool calls found in client logs within the window (log directories exist but no matching transcripts or calls).";
  }
  return undefined;
}

/**
 * Apply usage-aware trim: never-used tools (0 calls in window) are removed from hot set.
 */
export function applyUsageAwareHotSet(
  meters: ToolMeter[],
  policy: PolicyOptions,
  scan: UsageScanResult
): { hot: Set<string>; disabledServers: Set<string>; usageDeferKeys: Set<string> } {
  const base = selectHotToolsWithPolicy(meters, policy);
  const usageDeferKeys = new Set<string>();
  for (const m of meters) {
    const key = toolKey(m.server, m.name);
    if (base.disabledServers.has(m.server)) {
      continue;
    }
    const calls = countForTool(scan.counts, m.server, m.name);
    if (calls === 0 && base.hot.has(key)) {
      base.hot.delete(key);
      usageDeferKeys.add(key);
    }
  }
  return { ...base, usageDeferKeys };
}

export function usageDeferSavingsTokens(
  meters: ToolMeter[],
  usageDeferKeys: Set<string>
): number {
  return meters
    .filter((m) => usageDeferKeys.has(toolKey(m.server, m.name)))
    .reduce((s, m) => s + m.estTokens, 0);
}

export function attachUsageToReport(
  report: Report,
  scan: UsageScanResult,
  usageDeferKeys?: Set<string>
): Report {
  const tools = buildUsageRows(report, scan);
  const deferKeys =
    usageDeferKeys ??
    new Set(
      tools.filter((t) => !t.used).map((t) => toolKey(t.server, t.tool))
    );
  const hasSignal = hasUsageSignal(scan);
  const savingsTokens = hasSignal
    ? report.tools
        .filter((m) => deferKeys.has(toolKey(m.server, m.name)))
        .reduce((s, m) => s + m.estTokens, 0)
    : 0;

  return {
    ...report,
    usage: {
      sinceIso: scan.sinceIso,
      windowDays: scan.windowDays,
      clients: scan.clients.map(({ scannedPaths: _paths, ...rest }) => rest),
      tools,
      usageDeferSavingsEstTokens: savingsTokens,
      noLogsPlainMessage: plainNoLogsMessage(scan),
    },
  };
}

export function formatUsageClientLines(report: Report): string[] {
  const lines: string[] = [];
  const usage = report.usage;
  if (!usage) {
    return lines;
  }
  lines.push("");
  lines.push(`Tool usage (local logs, since ${usage.sinceIso}, ~${usage.windowDays}d window):`);
  if (usage.noLogsPlainMessage) {
    lines.push(`  ${usage.noLogsPlainMessage}`);
  }
  for (const c of usage.clients) {
    const status =
      c.status === "ok"
        ? c.message ?? "ok"
        : c.message ?? c.status;
    lines.push(`  ${c.id}: ${status}`);
  }
  lines.push("");
  lines.push("Used vs unused tools (names and counts only):");
  const byServer = new Map<string, ToolUsageRow[]>();
  for (const row of usage.tools) {
    if (!byServer.has(row.server)) {
      byServer.set(row.server, []);
    }
    byServer.get(row.server)!.push(row);
  }
  for (const [server, rows] of [...byServer.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1
  )) {
    lines.push(`  ${server}:`);
    for (const row of rows.sort((a, b) => a.tool.localeCompare(b.tool))) {
      const label = row.used ? "used" : "unused";
      lines.push(`    ${row.tool}: ${row.callCount} calls (${label}, ~${row.estTokens} est tokens)`);
    }
  }
  if (usage.usageDeferSavingsEstTokens > 0) {
    lines.push("");
    lines.push(
      `  Usage-aware defer savings (never-used tools): ~${usage.usageDeferSavingsEstTokens} tokens (estimate)`
    );
  }
  return lines;
}

export function mergeUsageSavingsIntoSummary(
  savings: SavingsSummary | undefined,
  usageDeferSavingsEstTokens: number
): SavingsSummary | undefined {
  if (!savings && usageDeferSavingsEstTokens <= 0) {
    return savings;
  }
  const base = savings ?? {
    currentEstTokens: 0,
    proposedEstTokens: 0,
    savedEstTokens: 0,
    savedPct: 0,
  };
  return {
    ...base,
    usageDeferSavingsEstTokens,
  };
}
