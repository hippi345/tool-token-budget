# Tool Token Budget

[![Tool Token Budget CI](https://github.com/hippi345/tool-token-budget/actions/workflows/tool-token-budget.yml/badge.svg)](https://github.com/hippi345/tool-token-budget/actions/workflows/tool-token-budget.yml)

**Measure MCP tool schema token cost → lint bloat → emit slim keep / defer proposals.**

Source: [github.com/hippi345/tool-token-budget](https://github.com/hippi345/tool-token-budget)

npm package: `tool-token-budget`. CLI binaries: `tool-token-budget` (primary) and `schema-budget` (backward-compatible alias to the same entrypoint — see `package.json` `bin` field).

Offline, deterministic, CI-friendly. No LLM. No cloud uploads.

```bash
npx tool-token-budget analyze --tools-json fixtures/tools-bloated.json
npx tool-token-budget emit --tools-json fixtures/tools-bloated.json --out ./ttb-out --keep-hot 3
npx tool-token-budget lint-server --tools-json my-tools.json  # Author mode
npx tool-token-budget doctor
```

## Why

MCP clients load tool names, descriptions, and JSON schemas into model context. A few chatty servers can burn thousands of tokens before you ask anything. `tool-token-budget` estimates that cost, ranks offenders, and writes **sibling** proposal files you can review — it never overwrites your `mcp.json`.

## Demo

**Visual demo:**

![Tool Token Budget Demo](https://raw.githubusercontent.com/hippi345/tool-token-budget/main/demos/tool-token-budget-demo.gif)

*Animated demo showing bloated fixture analysis → 99% token savings*

To regenerate the demo GIF:
```bash
# Requires asciinema + agg (see demos/GIF_GENERATION.md)
bash demos/render-gif.sh
```

**Text output:**

See [demos/demo-output.txt](demos/demo-output.txt) for a full example showing:
- Bloated fixture analysis: **~3550 tokens** across 5 tools
- Emit with `--keep-hot 2`: saves **~3519 tokens (99.13%)**
- Tools to defer: `mega_search`, `medium_list`, `beta`

Run it yourself:
```bash
cd demos && bash demo.sh
```

## Install

```bash
npm install -g tool-token-budget   # or use npx (`schema-budget` bin alias)
# Node >= 20
```

From this repo:

```bash
npm install
npm run build
node dist/cli.js doctor
```

## Fixture demo (no live MCPs / no secrets)

```bash
# Ranked table + lint findings (numbers labeled as estimates)
node dist/cli.js analyze --tools-json fixtures/tools-bloated.json

# Per-model columns (legacy o200k total unchanged without flags)
node dist/cli.js analyze --tools-json fixtures/tools-bloated.json --model claude-sonnet-4-5 --count-mode offline
```

See [docs/per-model-token-counts.md](docs/per-model-token-counts.md) for framing assumptions, optional `@huggingface/tokenizers` peer, and API counting.

```bash
# Machine-readable + defer/keep proposals
node dist/cli.js emit --tools-json fixtures/tools-bloated.json --out /tmp/ttb-out --keep-hot 3
ls /tmp/ttb-out
# report.json  defer-hints.json  tool-token-budget.keep.json  (+ optional proposed config)

# Optional HTML
node dist/cli.js analyze --tools-json fixtures/tools-bloated.json --html /tmp/sb.html
# Author mode: lint your server before publishing
node dist/cli.js lint-server --tools-json fixtures/tools-bloated.json
# Exit 1 if schema-too-large or other warnings found
```


## GUI

**Local web dashboard** for exploring, editing, and exporting tool token budgets with live updates:

![Tool Token Budget Dashboard](https://raw.githubusercontent.com/hippi345/tool-token-budget/main/screenshots/dashboard-stage-b.png)
*Dashboard view showing servers, tools, and live savings*

```bash
npx tool-token-budget ui mcp.json
# Opens browser to http://127.0.0.1:<random-port>?token=<one-time-token>
# Polls for changes every 30s (configurable with --watch-interval)
```

### Features

#### Dashboard (View)
- Live re-discovery every N seconds (default 30, min 10)
- Real-time change feed showing added/removed servers and tools with token deltas
- Per-server table with tool counts, tokens, and lint findings (sortable)
- Top 10 tools by token cost
- Lint summary with severity badges
- Current savings estimate with default proposal

#### Editor (Stage B)
- **Policy editor** with real-time proposal generation:
  - Per-tool keep/defer checkboxes for granular control
  - Per-server "keep N cheapest" controls
  - Global policy controls (keep-hot, keep-per-server, disable-servers-over)
  - Preset buttons: Aggressive (1/server), Default (2/server), Minimal (3/server)
  - Live savings calculation and display
  - Warning when any server would have zero kept tools (removal warning)
- **Export proposals** to disk:
  - Writes same files as CLI `emit`: report.json, keep proposal, defer hints, proposed config
  - Never overwrites mcp.json (uses `.tool-token-budget-proposed.json` suffix; legacy `.schema-budget-proposed.json` still applied when present)
  - Secrets always appear as `<from-original>` in outputs
- **Client selector** in header:
  - Auto-detects configs for Cursor, Claude Desktop, Claude Code, VS Code, Windsurf, Antigravity, Gemini CLI, OpenAI Codex CLI, GitHub Copilot
  - Switch between detected clients on the fly
  - View-only mode for clients without emit profiles (export disabled)

#### Lint Drill-Down
- Filter by severity: All, Error, Warn, Info
- Expandable findings with:
  - Rule ID, severity, server::tool
  - Static trim suggestions (no LLM)
  - Tool token breakdown and share-of-server percentage

#### Settings Panel
- **Theme:** Light / Dark / System (respects prefers-color-scheme)
- **Refresh interval:** Configurable seconds (min 10)
- **Default policy:** Keep-per-server and keep-hot defaults

### Security
- Binds to `127.0.0.1` only (never `0.0.0.0`)
- One-time session token required on every API call
- Host header validation (DNS-rebinding defense)
- Origin header validation on POST endpoints
- No permissive CORS
- Browser never supplies filesystem paths (client selection by ID only)
- All env/headers values redacted to `<from-original>` in responses

The GUI is built with React + Vite and bundled into the npm package. No separate install needed.

Options:
- `--port <number>` — custom port (default: random)
- `--no-open` — print URL instead of opening browser
- `--watch-interval <sec>` — polling interval (default 30, min 10)
- `--export-dir <dir>` — root directory for exports (default: `<cwd>/tool-token-budget-export`)

**Export location:** GUI exports always go to `<export-dir>/<timestamp>/` where timestamp is Windows-safe (no colons). The browser cannot control the export path—this is a security feature to prevent writing to arbitrary locations.

### Supported MCP clients (CLI `--client` / GUI picker)

See [docs/client-config-paths.md](docs/client-config-paths.md) for full paths. Highlights:

| Client | User config | Project override | Schema | Writes |
|--------|-------------|------------------|--------|--------|
| Cursor, Claude, … | varies | varies | `mcpServers` JSON | ✅ |
| OpenAI Codex CLI | `~/.codex/config.toml` (`$CODEX_HOME`) | `.codex/config.toml` | `[mcp_servers.*]` TOML | ✅ |

## Commands

| Command | Purpose |
|---------|---------|
| `analyze [config]` | Discover → meter → lint → text/`--json`/`--html`/`--sarif` report (`--client <id>` or any client config path, including Codex `config.toml`) |
| `emit [config]` | Same analysis; write sibling artifacts under `--out` |
| `lint-server` | **Author mode:** Fail CI on bloated schemas (for publishers) |
| `apply` | Apply proposed config to mcp.json (default: dry-run) |
| `sync` | Copy MCP server definitions from one client config to another (`--from` / `--to`) |
| `history` | Local analyze totals over time (sparklines; `--json` for machines) |
| `ui [config]` | Local web GUI: dashboard, editor, lint drill-down, live polling (Stages A+B) |
| `doctor` | Node version, tokenizer load, tiny fixture smoke |

Useful flags:

- `--client <id>` — resolve config path (same ids as `emit` / `apply` / `ui`; alias `vscode` → `vscode-user`)
- `--tools-json <file>` — offline fixtures (bypass live discover)
- `--budget <tokens>` — exit `1` if total estimate exceeds
- `--fail-on <info\|warn\|error>` — exit `1` on lint severity
- `--keep-hot <n>` — N **lowest** estimate tools stay hot (global, explicit opt-in)
- `--keep-per-server <n>` — keep up to N cheapest tools **per server** (default: 2)
- `--disable-servers-over <tokens>` — disable entire servers over threshold (warns on removal)
- `--format mcp-json\|defer-hints\|both` — emit selection (default `both`)
- `--profile claude\|cursor\|generic\|vscode\|windsurf\|gemini-settings\|antigravity\|codex` — emit emphasis (affects proposal format)
- `--timeout <ms>` — stdio discover timeout (default 15000)
- `--watch` — watch config/tools files and re-run on changes (debounced)
- `--watch-interval <sec>` — polling interval for watch mode and UI live polling (default 30, min 10)
- `--no-history` — skip appending this run to local analyze history
- `--fail-over-budget` — exit `3` when a user-config token budget is exceeded (warnings always print)

### Local analyze history & token budgets (Stage 3d)

Each successful `analyze` appends a small JSON record (timestamp, total tokens, per `--client` id, per model column) to a local history file under your per-user state directory (same AppData / XDG resolution as client discovery). The file keeps only the most recent **200** runs by default (override with `history.maxEntries` in user config). Opt out with `--no-history`, `TOOL_TOKEN_BUDGET_NO_HISTORY=1`, or `"history": { "enabled": false }` in user config. Corrupt history never fails analyze (warning + fresh append).

- **History file (Windows):** `%APPDATA%\tool-token-budget\analyze-history.json` (`%APPDATA%` defaults to `%USERPROFILE%\AppData\Roaming`).
- **User config (budgets + history options):** `<state-dir>/config.json` (see `TOOL_TOKEN_BUDGET_STATE_DIR`, `TOOL_TOKEN_BUDGET_USER_CONFIG`).

```json
{
  "history": { "enabled": true, "maxEntries": 200 },
  "budget": {
    "total": 120000,
    "clients": { "cursor-global": 80000 },
    "models": { "openai:o200k": 90000 }
  }
}
```

`history` prints unicode sparklines for totals and each client/model series. The GUI dashboard includes a full-width history chart (axes, legend, per-client series, budget reference lines, hover tooltips) fed by `GET /api/analyze-history`.

**Windows laptop check (sandbox profile — does not touch your real `%USERPROFILE%`):**

```powershell
$realProfile = $env:USERPROFILE
$sandbox = Join-Path $env:TEMP "ttb-stage3d-sandbox"
New-Item -ItemType Directory -Force -Path $sandbox, "$sandbox\.cursor", "$sandbox\AppData\Roaming\tool-token-budget" | Out-Null
$env:USERPROFILE = $sandbox
$env:APPDATA = Join-Path $sandbox "AppData\Roaming"
Copy-Item -Force (Join-Path $realProfile ".cursor\mcp.json") (Join-Path $sandbox ".cursor\mcp.json")
npx tool-token-budget analyze --client cursor-global
npx tool-token-budget analyze --client cursor-global
npx tool-token-budget history
Set-Content -Encoding utf8 (Join-Path $env:APPDATA "tool-token-budget\config.json") '{"budget":{"clients":{"cursor-global":1}}}'
npx tool-token-budget analyze --client cursor-global --fail-over-budget; $LASTEXITCODE   # expect 3
$before = (Get-Content (Join-Path $env:APPDATA "tool-token-budget\analyze-history.json") | ConvertFrom-Json).entries.Count
npx tool-token-budget analyze --client cursor-global --no-history
$after = (Get-Content (Join-Path $env:APPDATA "tool-token-budget\analyze-history.json") | ConvertFrom-Json).entries.Count
$after -eq $before   # True
npx tool-token-budget ui --no-open --client cursor-global
```

Use a multi-line here-string when you prefer readable JSON:

```powershell
@'
{
  "budget": { "clients": { "cursor-global": 1 } }
}
'@ | Set-Content -Encoding utf8 $cfg
```

### UI Watch Interval Control

The `ui` command starts a local web server with live SSE updates. The refresh interval can be controlled:

- **CLI flag:** `--watch-interval <sec>` sets the initial server polling interval
- **GUI Settings:** Change the interval dynamically (10-3600s enforced)
- **Persistence:** GUI applies saved interval on load and displays effective interval from server
- **Security:** Changes require token authentication with Host/Origin validation

**Default behavior:** Per-server keeping ensures every server stays in the proposed config with at least its 2 cheapest tools hot. Use explicit `--keep-hot` or `--disable-servers-over` to opt into global policies that may remove servers (warnings are printed when servers are removed).

**Apply command:** `tool-token-budget apply` is dry-run by default (shows diff without writing). Use `--dry-run` explicitly or run with `--backup --yes` to apply changes. The `--dry-run` flag cannot be combined with `--yes`.

**Sync command:** `tool-token-budget sync --from <client-id> --to <client-id|all>` copies the source client's MCP server map to one or more targets (add/update/remove to match). Default is interactive: a per-target diff preview, then confirmation. Use `--dry-run` to preview without writing (no backups). Use `--yes` to apply immediately (creates a timestamped backup before each changed file; new target files are created with parent directories and no backup). With an explicit `--to <client>`, a missing target config is planned as a **new file** (all servers shown as added); `--to all` still skips clients whose config file is not present. Use `--json` for machine-readable plan/result; with `--json`, errors are printed as JSON on stdout (`error`, `code`, plus context) with the same exit codes as the human CLI. Unsupported fields or disabled flags that the target cannot represent produce warnings and skip the affected server rather than writing lossy entries.

**Sync sandbox (Windows, real write):** Node resolves your profile with `os.homedir()` (`%USERPROFILE%` on Windows, not Git Bash’s `HOME`). In a **new** PowerShell window, point the profile (and AppData when syncing Claude Desktop or VS Code user config) at a throwaway folder, seed configs there, then sync and confirm backups stay under that sandbox:

```powershell
$realProfile = $env:USERPROFILE
$sandbox = Join-Path $env:TEMP "ttb-sync-sandbox"
New-Item -ItemType Directory -Force -Path $sandbox, "$sandbox\.cursor", "$sandbox\.codeium\windsurf" | Out-Null
$env:USERPROFILE = $sandbox
$env:APPDATA = Join-Path $sandbox "AppData\Roaming"
Copy-Item (Join-Path $realProfile ".cursor\mcp.json") (Join-Path $sandbox ".cursor\mcp.json")
Copy-Item (Join-Path $sandbox ".cursor\mcp.json") (Join-Path $sandbox ".codeium\windsurf\mcp_config.json")
npx tool-token-budget sync --from cursor-global --to windsurf --yes
Get-ChildItem -Recurse $sandbox -Filter ".bak-*"
```

**SARIF output:** Use `analyze --format sarif` or `analyze --sarif <path>` for GitHub Code Scanning compatible output.

Exit codes: `0` ok · `1` CLI `--budget` / `--fail-on` lint · `2` usage/config error · `3` user-config budget exceeded (`--fail-over-budget`)

## CI Integration

See [.github/workflows/tool-token-budget.yml](.github/workflows/tool-token-budget.yml) for a complete GitHub Actions example that:
- Runs `analyze` with `--budget` and `--fail-on` checks
- Uses `lint-server` for author/publisher validation
- Uploads `report.json` and SARIF reports as artifacts
- Posts savings summary to PR comments
- Integrates with GitHub Code Scanning via SARIF format

Example step:
```yaml
- name: Check MCP tool token budget
  run: |
    npx tool-token-budget analyze \
      --tools-json my-tools.json \
      --budget 5000 \
      --fail-on warn \
      --sarif tool-token-budget.sarif

- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v2
  if: always()
  with:
    sarif_file: tool-token-budget.sarif
```

For Origin CI or other platforms, adapt the workflow to your runner's environment.

## Architecture

```
mcp.json / tools JSON  →  discover  →  meter  →  lint  →  report
                                              ↘  emit (keep / defer / report.json)
```

- **Tokenizer:** `js-tiktoken` encoding **`o200k_base`**. All user-facing numbers are **estimates**.
- **keep-hot N:** N lowest `estTokens` tools → `defer_loading: false`; rest `true`. Ties: lexicographic `server::name`.
- **Emit siblings only:** `report.json`, `defer-hints.json`, `tool-token-budget.keep.json` (legacy `schema-budget.keep.json` still read) — never mutates your mcp.json in place.
- **Usage-aware trim:** `analyze` / `emit` scan local Claude Code, Codex, and Cursor logs (read-only; `--since` default `30d`). See [docs/usage-log-sources.md](docs/usage-log-sources.md).
- **Live discover:** Cursor/Claude-style `{ "mcpServers": { ... } }` stdio servers via `@modelcontextprotocol/sdk`. Remote/OAuth: **warn + skip**; use `--tools-json`.

## Honest limits (v1)

- Token counts are **estimates**, not vendor billing numbers.
- **No LLM** rewrite of descriptions/schemas.
- **Remote / OAuth** MCP servers are not probed live (warn + skip).
- **Cursor vs Claude:** `defer-hints.json` is Claude-oriented (`defer_loading`). Cursor may need enable/disable lists or an on-demand proxy instead — same numbers, different apply path.
- Does **not** auto-apply changes to `mcp.json`.
- Env values from configs are **redacted** (`***`) in reports.

## Lint rules (defaults)

| ruleId | Default trigger | Severity |
|--------|-----------------|----------|
| `description-too-long` | description > 500 chars | warn |
| `schema-too-large` | schema estimate > 800 tokens | warn |
| `huge-enum` | enum length > 50 | warn |
| `deep-schema` | nesting depth > 6 | info |
| `duplicate-description-boilerplate` | identical description > 40 chars on ≥2 tools | info |

## Testing and contributing

```bash
npm ci
npm run build
npm test
```

End-to-end UI tests use Playwright. Install the browser once per machine:

```bash
npm run test:e2e:setup
# equivalent: npx playwright install chromium
npm run test:e2e
```

Unit tests use an isolated fake `HOME` under the system temp directory (unique per vitest worker); they do not read or write your real MCP config.

## License

MIT — Copyright (c) 2026 Joel Shearon. See [LICENSE](LICENSE).
