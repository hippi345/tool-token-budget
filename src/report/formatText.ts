import type { Report } from "../types.js";
import { formatUsageClientLines } from "../usage/usageTrim.js";

export interface FormatTextReportOptions {
  /** Include per-model framing overhead lines (CLI --per-tool or --verbose text). */
  perModelDetail?: boolean;
}

/** Human-readable terminal report; always labels numbers as estimates. */
export function formatTextReport(
  report: Report,
  opts?: FormatTextReportOptions
): string {
  const lines: string[] = [];
  lines.push("tool-token-budget - MCP schema token estimates");
  lines.push(`tokenizer: ${report.tokenizerId} (estimate)`);
  lines.push(
    `totals: ~${report.totals.estTokens} tokens (estimate) across ${report.totals.toolCount} tools / ${report.totals.serverCount} servers`
  );
  const configDisabled = report.servers.filter((s) => s.status === "config_disabled");
  if (configDisabled.length > 0) {
    lines.push("");
    lines.push("Disabled servers (config, 0 active tokens):");
    for (const s of configDisabled) {
      lines.push(`  ${s.name}`);
    }
  }
  lines.push("");
  lines.push("Ranked tools (estimate, highest first):");
  lines.push(
    pad("SERVER", 18) + pad("TOOL", 24) + pad("EST", 8) + pad("NAME", 6) + pad("DESC", 6) + "SCHEMA"
  );
  lines.push("-".repeat(72));
  for (const t of report.tools) {
    lines.push(
      pad(t.server, 18) +
        pad(t.name, 24) +
        pad(String(t.estTokens), 8) +
        pad(String(t.breakdown.name), 6) +
        pad(String(t.breakdown.description), 6) +
        String(t.breakdown.schema)
    );
  }
  if (report.savings) {
    lines.push("");
    lines.push("Savings summary (estimates):");
    lines.push(`  Current:  ~${report.savings.currentEstTokens} tokens (estimate)`);
    lines.push(`  Proposed: ~${report.savings.proposedEstTokens} tokens (estimate)`);
    lines.push(`  Saved:    ~${report.savings.savedEstTokens} tokens (estimate, ${report.savings.savedPct}%)`);
    if (report.savings.usageDeferSavingsEstTokens) {
      lines.push(
        `  Usage defer (never-used): ~${report.savings.usageDeferSavingsEstTokens} tokens (estimate)`
      );
    }
  }
  lines.push(...formatUsageClientLines(report));
  if (report.tokenCountsByModel && Object.keys(report.tokenCountsByModel).length > 0) {
    lines.push("");
    lines.push("Per-model token totals:");
    for (const [modelId, summary] of Object.entries(report.tokenCountsByModel)) {
      const label =
        summary.source === "exact-api"
          ? "api"
          : summary.source === "exact-offline"
            ? "exact"
            : "estimate";
      const prefix = label === "estimate" ? "~" : "";
      lines.push(
        `  ${modelId}: ${prefix}${summary.total} tokens (${label}, framing=${summary.framing})`
      );
      if (opts?.perModelDetail) {
        const overhead = summary.framingOverhead ?? 0;
        if (overhead > 0 || modelId === "cursor-dynamic") {
          lines.push(`    framing overhead: ${overhead}`);
        }
      }
    }
    const legacyTotal = report.totals.estTokens;
    lines.push(
      `  (legacy ranked column total: ~${legacyTotal} tokens, sum of per-field o200k estimates)`
    );
  }
  if (report.findings.length > 0) {
    lines.push("");
    lines.push(`Lint findings (${report.findings.length}):`);
    for (const f of report.findings) {
      lines.push(
        `  [${f.severity}] ${f.ruleId} ${f.server}::${f.tool} - ${f.message}`
      );
    }
  }
  return lines.join("\n");
}

function pad(s: string, n: number): string {
  return (s.length >= n ? s.slice(0, n - 3) + "..." : s).padEnd(n);
}
