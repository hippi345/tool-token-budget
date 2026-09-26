#!/usr/bin/env bash
set -euo pipefail

FIXTURE="fixtures/tools-bloated.json"
echo "# Analyze a bloated MCP tool fixture"
echo "$ node dist/cli.js analyze --tools-json $FIXTURE"
node dist/cli.js analyze --tools-json "$FIXTURE"

report_file="$(mktemp)"
trap 'rm -f "$report_file"' EXIT
node dist/cli.js analyze --tools-json "$FIXTURE" --json >"$report_file"
node - "$report_file" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const hot = [...report.tools].sort((a, b) => a.estTokens - b.estTokens || `${a.server}::${a.name}`.localeCompare(`${b.server}::${b.name}`)).slice(0, 3);
const proposed = hot.reduce((sum, tool) => sum + tool.estTokens, 0);
const saved = report.totals.estTokens - proposed;
const pct = report.totals.estTokens ? (saved / report.totals.estTokens) * 100 : 0;
console.log("");
console.log(`Savings (estimate, keep-hot 3): savedEstTokens ~${saved}; savedPct ${pct.toFixed(1)}%`);
console.log(`Proposed hot-load cost: ~${proposed} tokens (from ~${report.totals.estTokens})`);
NODE
