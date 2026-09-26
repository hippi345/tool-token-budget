import type { Report } from "../types.js";
import { defaultProposedFilename } from "../branding/artifactPaths.js";

/** Polished static HTML report with savings banner and offenders table. */
export function formatHtml(report: Report): string {
  const savingsBanner = report.savings
    ? `<div class="savings-banner">
<h2>Estimated Savings</h2>
<div class="savings-grid">
<div class="metric">
<div class="label">Current</div>
<div class="value">~${report.savings.currentEstTokens} tokens</div>
</div>
<div class="metric">
<div class="label">Proposed</div>
<div class="value">~${report.savings.proposedEstTokens} tokens</div>
</div>
<div class="metric">
<div class="label">Saved</div>
<div class="value">~${report.savings.savedEstTokens} tokens</div>
</div>
<div class="metric">
<div class="label">Reduction</div>
<div class="value">${report.savings.savedPct}%</div>
</div>
</div>
<p class="cta">Review proposed configuration: <code>${defaultProposedFilename()}</code></p>
</div>`
    : "";

  const offendersRows = report.tools
    .slice(0, 10)
    .map((t, idx) => {
      const lintHits = report.findings.filter(
        (f) => f.server === t.server && f.tool === t.name
      ).length;
      return `<tr><td>${idx + 1}</td><td>${esc(t.server)}</td><td>${esc(
        t.name
      )}</td><td>${t.estTokens}</td><td>${lintHits}</td></tr>`;
    })
    .join("\n");

  const allToolsRows = report.tools
    .map(
      (t) =>
        `<tr><td>${esc(t.server)}</td><td>${esc(t.name)}</td><td>${
          t.estTokens
        }</td><td>${t.breakdown.name}</td><td>${t.breakdown.description}</td><td>${
          t.breakdown.schema
        }</td></tr>`
    )
    .join("\n");

  const findings = report.findings
    .map(
      (f) =>
        `<li><strong>[${esc(f.severity)}]</strong> ${esc(f.ruleId)} ${esc(
          f.server
        )}::${esc(f.tool)} — ${esc(f.message)}${
          f.suggestion ? `<br/><em>→ ${esc(f.suggestion)}</em>` : ""
        }</li>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Tool Token Budget report</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;color:#111;max-width:1200px;margin:2rem auto}
h1{margin-bottom:.5rem}
h2{margin-top:2rem;margin-bottom:1rem;border-bottom:2px solid #e0e0e0;padding-bottom:.5rem}
.muted{color:#666;font-size:.95rem}
.savings-banner{background:linear-gradient(135deg,#e8f5e9 0%,#c8e6c9 100%);border-radius:8px;padding:1.5rem;margin:2rem 0;border:2px solid #4caf50}
.savings-banner h2{margin-top:0;border:none;color:#2e7d32}
.savings-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1rem;margin:1rem 0}
.metric{text-align:center;padding:1rem;background:rgba(255,255,255,0.7);border-radius:4px}
.metric .label{font-size:.85rem;color:#666;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.5rem}
.metric .value{font-size:1.5rem;font-weight:700;color:#1b5e20}
.cta{margin-top:1rem;padding:.75rem;background:rgba(255,255,255,0.9);border-radius:4px;font-size:.95rem}
.cta code{background:#fff;padding:.2rem .5rem;border-radius:3px;font-family:monospace;color:#d32f2f}
table{border-collapse:collapse;width:100%;margin:1rem 0}
th,td{border:1px solid #ddd;padding:.6rem .8rem;text-align:left}
th{background:#f5f5f5;font-weight:600}
tr:hover{background:#fafafa}
ul{list-style:none;padding:0}
ul li{padding:.5rem;margin:.5rem 0;background:#f9f9f9;border-left:3px solid #2196f3;border-radius:3px}
ul li em{color:#666;font-size:.9rem}
</style>
</head>
<body>
<h1>Tool Token Budget</h1>
<p class="muted">Token counts are <strong>estimates</strong> (${esc(
    report.tokenizerId
  )}). All numbers are estimates only.</p>
<p class="muted">Total estimate: <strong>~${
    report.totals.estTokens
  }</strong> tokens · ${report.totals.toolCount} tools · ${
    report.totals.serverCount
  } servers</p>

${savingsBanner}

${
  offendersRows
    ? `<h2>Top Token Offenders</h2>
<table>
<thead><tr><th>Rank</th><th>Server</th><th>Tool</th><th>Est Tokens</th><th>Lint Hits</th></tr></thead>
<tbody>
${offendersRows}
</tbody>
</table>`
    : ""
}

<h2>All Tools (Ranked by Token Cost)</h2>
<table>
<thead><tr><th>Server</th><th>Tool</th><th>Est</th><th>Name</th><th>Desc</th><th>Schema</th></tr></thead>
<tbody>
${allToolsRows}
</tbody>
</table>

<h2>Lint Findings</h2>
<ul>
${findings || "<li>None</li>"}
</ul>
</body>
</html>
`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
