# Changelog

All notable changes to schema-budget will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2026-09-25

### Added (Stage 3d: analyze history & budgets)

- **`history` command** — sparklines for total tokens and per client/model series; `--json`, `--client`, `--model`, `--limit`, `--since`
- **Local analyze history** — append-only `analyze-history.json` under per-user `tool-token-budget` state dir (rotated, opt-out via flag/env/config)
- **User config budgets** — `config.json` `budget.total` / `budget.clients` / `budget.models`; warnings on exceed/near-limit; `--fail-over-budget` exit code `3`; `budgetStatus` in `analyze --json`
- **GUI** — dashboard history chart (`/api/analyze-history`) with e2e coverage

### Added (Stage C: Apply from GUI)

#### Apply Endpoints
- **POST /api/apply/preview**: Returns before/after diff with `<from-original>` sentinels for secrets
  - Computes SHA-256 hash of current on-disk config file
  - Diff shows proposed changes with secrets redacted
  - Full security enforcement (token, Host, Origin checks)
- **POST /api/apply**: Applies proposed config with guarded confirmation
  - Requires `previewHash` and `confirmation="apply"` (exact string match)
  - Returns 409 if file changed since preview (hash mismatch)
  - Creates timestamped backup before writing (format: `mcp.json.bak-YYYY-MM-DDTHH-MM-SS`)
  - Atomic write: temp file + rename for safety
  - Re-hydrates secrets using shared `restoreSecrets` code from CLI apply
  - Returns backup path in success response

#### GUI Apply Features
- Apply section in Editor with Preview and Apply buttons
- Preview shows before/after diff view
- Confirmation input (must type "apply" exactly)
- Apply button disabled until confirmation typed
- Success message displays backup path
- 409 conflict handling with clear "re-preview" message
- View-only clients (VS Code, Windsurf, etc.) refused for apply operations

#### Security (All Enforced)
- Token authentication on both endpoints
- Host header validation (127.0.0.1 or localhost only)
- Origin header validation with exact port match (new URL parsing)
- Missing Origin rejected for state-changing POSTs
- No browser-supplied paths (clientId only, never accepts path-like fields)
- View-only clients refused for apply operations
- Apply may touch ONLY chosen client's config file and its backup
- Path containment checks via shared `realpath` helper

#### Testing
- 19 new Stage C unit tests (`test/stage-c.test.ts`)
  - Security enforcement (token, Host, Origin, confirmation)
  - 409 on hash mismatch
  - Secret restoration byte-exact verification
  - View-only client refusal
  - Path-like field rejection
- Playwright e2e test for apply UI workflow
- Total: 155 unit tests + 14 e2e tests = 169 passing

### Fixed (Stage B Bug Fixes - Complete)

#### Cosmetic Fixes from Laptop Testing
- **GUI Export Response**: Fixed field name mismatch - server returns `exportDir` but GUI expected `outDir`
  - Updated `gui/src/types.ts`: renamed `ExportResponse.outDir` to `exportDir`
  - Updated `gui/src/Editor.tsx`: use `result.exportDir` instead of `result.outDir`
- **Export Folder Names**: Switched to readable timestamps for better user experience
  - Old format: `1727234567890-a1b2c3` (epoch milliseconds + hex)
  - New format: `2026-09-25T04-45-12-123-82bd` (human-readable, Windows-safe, no colons)
  - Maintains millisecond precision + random hex suffix for uniqueness
  - Exclusive mkdir with retry on EEXIST still enforced
  - Existing parallel-export uniqueness tests updated and passing

#### Security: Export Path Control (Critical)
- **SECURITY FIX**: Export endpoint now rejects any browser-supplied paths (`outDir`, `path`, `dir`, etc.)
- Exports always go to server-controlled location: `<cwd>/schema-budget-export/<timestamp>/`
- Added `--export-dir <dir>` CLI flag to override export root (server-side only)
- Guard prevents writing into or next to live config directory (tested)
- Timestamp format is Windows-safe (no colons: `2026-09-25T06-30-00`)
- Export response now includes absolute `exportDir` path
- Defer-hints.json always written (CLI parity, not just for Claude profiles)
- Comprehensive security tests: path traversal, absolute paths, config directory guard

#### Policy Defaults
- Shared policy normalization function ensures CLI and API use same defaults
- Empty policy `{}` now correctly uses `keepPerServer: 2` (CLI default)
- Fixed `removedServersCount` to count all dropped servers (including zero-tool servers)
- All policy endpoints (`/api/proposal`, `/api/export`) normalize policy before use

#### Settings Integration (Complete)
- **Live interval control**: `POST /api/watch-interval` changes server's polling interval (10-3600s enforced)
- GUI Settings applies saved interval on load and on change
- Settings displays effective interval from server (`/api/health` `watchIntervalSec`)
- Default policy from Settings is applied to Editor on load
- Token auth, Host check, Origin validation, JSON content-type on POST endpoint

### Changed
- Export API response format: `outDir` → `exportDir` (absolute path)
- Export file set always includes `defer-hints.json` (was conditional on Claude profile)
- Settings refresh interval now controls server polling (not reserved)

### Added
- `--export-dir <dir>` flag for `ui` command (default: `<cwd>/schema-budget-export`)
- `POST /api/watch-interval` endpoint with full security checks
- Server watch interval exposed in `/api/health` response (`watchIntervalSec`)
- Poller `setInterval(sec)` and `getInterval()` methods for runtime control
- 23+ new tests: export security, policy defaults, watch interval control, config-dir guard

## [1.0.0] - 2026-09-23

### Added

#### Stage A - Real-config functional testing
- Config fixtures covering Cursor-style and Claude-style MCP configs
- Live stub integration test with fixtures/stub-mcp-server.mjs
- Smoke script `npm run smoke:real` for regression testing
- Remote/OAuth entry warning and skip (no crash)
- Secret value redaction in all report outputs
- Comprehensive test suite with 38+ tests

#### Stage B - Actionable emit
- Full proposed config file generation (`mcp.json.schema-budget-proposed.json`)
- Savings summary in CLI and report: `currentEstTokens`, `proposedEstTokens`, `savedEstTokens`, `savedPct`
- `schema-budget apply` command with `--dry-run`, `--backup`, `--yes` flags
- Keep policy flags:
  - `--keep-hot <n>`: Keep N cheapest tools hot
  - `--keep-per-server <n>`: Keep up to N cheapest tools per server
  - `--disable-servers-over <tokens>`: Disable entire servers over threshold
- `--profile claude|cursor|generic` option for emit emphasis
- Apply safety tests (no overwrite without backup+yes)

#### Stage C - More features / portfolio surface
- **README demo** showing bloated fixture → 99% token savings (3550 → 31 tokens)
- **GitHub Action workflow** example with:
  - Budget checking with `--budget` flag
  - Lint enforcement with `--fail-on` flag
  - Report artifact upload
  - Savings summary in PR comments
- **Author mode** `lint-server` command for publishers:
  - Fails CI on schema-too-large and related lint rules
  - Configurable `--fail-on <severity>` threshold
  - Clean success/failure reporting
- **npm publish prep**:
  - LICENSE file (MIT)
  - CHANGELOG with structured versioning
  - `files` field in package.json
  - Package metadata verification

### Core Features (Stages A+B+C)
- Deterministic token estimation using `o200k_base` encoding
- MCP server discovery from Cursor/Claude config files
- Tool schema metering and ranking
- Lint rules:
  - `description-too-long` (warn at 500 chars)
  - `schema-too-large` (warn at 800 tokens)
  - `huge-enum` (warn at 50+ values)
  - `deep-schema` (info at 6+ nesting levels)
  - `duplicate-description-boilerplate` (info)
- Multiple output formats: text, JSON, HTML
- Defer/keep proposal generation for Claude-style configs
- Safe config application with backup and dry-run modes

### Technical
- Node.js >= 20 requirement
- TypeScript codebase
- Vitest test suite
- Commander-based CLI
- MCP SDK integration (@modelcontextprotocol/sdk ^1.18.0)
- js-tiktoken for token estimation

## [Unreleased]

## [1.2.1-windows-fixes] - 2026-09-25

### Fixed
- **Windows cross-platform install**: Configured npm workspaces with single root lockfile to include all platform-specific esbuild and rollup binaries, eliminating version mismatch errors on `npm ci` on Windows
- **Windows test compatibility**: Fixed `cli-regression.test.ts` to use `pathToFileURL()` for ESM imports, resolving `ERR_UNSUPPORTED_ESM_URL_SCHEME` errors on Windows
- **Cross-platform error messages**: Improved spawn failure error messages to always include command name, making test assertions consistent across Linux and Windows
- **SSE event typing**: Fixed server-sent events to correctly emit `type: "update"` (with empty diff) for all polls after the initial snapshot, not `type: "initial"`
- **Spawn security**: Removed `shell: true` from Windows `openBrowser` spawn to prevent DEP0190 warning and command injection via `&` in URLs
- Added test for unauthenticated `/api/health` returning 401
- Added test for SSE no-change polls sending update events
- Added `playwright-report/` and `test-results/` to `.gitignore`

## [1.2.0-stage-a-fixes] - 2026-09-25

### Fixed - Windows compatibility and server robustness

All fixes include regression tests.

#### Fix 1: Host validation crash (ERR_INVALID_URL)
- **Problem:** Host header check used prefix-only validation (`startsWith`). Malicious header like `localhost:evil.example` passed the check, then `new URL(req.url, 'http://'+host)` threw ERR_INVALID_URL and crashed the server process.
- **Fix:** 
  - Exact host:port validation using regex (`^(127\.0\.0\.1|localhost):\d+$`)
  - Parse URL from fixed base (`http://127.0.0.1`) instead of untrusted Host header
  - Top-level try/catch in request handler returns 400/500 on errors, server never crashes
- **Test:** `test/windows-fixes.test.ts` - malformed Host and URL requests, server stays alive
- **Repro:** `curl -H "Host: localhost:evil.example" http://127.0.0.1:<port>/api/health` (no longer crashes)

#### Fix 2: SSE /api/events sends nothing on connect
- **Problem:** SSE clients connecting to `/api/events` received no data until the next polling interval (up to 30+ seconds). Event type was always `initial` instead of `update` for subsequent broadcasts.
- **Fix:**
  - Store `currentSnapshot` in server state
  - Send current snapshot immediately on connect as `type: initial`
  - Subsequent poll events are `type: update` with diff
- **Test:** `test/windows-fixes.test.ts` - SSE client receives initial event immediately, updates have correct type

#### Fix 3: Windows auto-open command bug
- **Problem:** `start "<url>"` on Windows treated the URL as window title and opened a terminal with token in the title.
- **Fix:** Use `cmd /c start "" "<url>"` (empty string as title, URL as target) via spawn with proper args, not shell string interpolation
- **Test:** Platform-specific command building verified in code

#### Fix 4: Windows test failures (path escaping)
- **Problem:** CLI regression tests passed Windows temp paths with backslashes into `node -e` JS strings, breaking with ENOENT.
- **Fix:** Write test scripts to temp `.mjs` files with absolute imports instead of inline `-e` strings. No shell escaping issues.
- **Test:** `test/cli-regression.test.ts` - all 4 tests now pass on Windows

#### Fix 4b: Integration test spawn error classification
- **Problem:** `missing-binary` test expected `spawn_failed` but Windows reported `handshake_failed` for non-existent binaries.
- **Fix:** Test accepts either status with explanatory comment (platform behavior differs; both indicate failure).
- **Test:** `test/integration.test.ts` - passes on Windows and Linux

#### Fix 5: Unknown /api/* paths return HTML fallback
- **Problem:** `/api/unknown` returned index.html (SPA fallback) instead of 404 JSON.
- **Fix:** Check `url.pathname.startsWith("/api/")` before SPA fallback, return 404 JSON for unknown API routes.
- **Test:** `test/windows-fixes.test.ts` - `/api/unknown` returns 404 JSON, not HTML

### Added - Dark Mode for GUI

#### Theme System
- **Default:** Respects OS setting via `prefers-color-scheme`
- **Toggle:** Light / Dark / System buttons in dashboard header
- **Persistence:** Choice saved in localStorage, survives reload
- **Implementation:** CSS variables (theme tokens) for Stage B inheritance
- **Contrast:** WCAG AA compliant in both themes
  - Tables: readable text/background contrast
  - Savings banner: green theme adapted for dark mode
  - Status badges: white text on colored backgrounds for consistency
  - Severity badges: appropriate contrast for info/warn/error

#### Theme Token System (CSS Variables)
- Light theme: bright backgrounds, dark text
- Dark theme: `#121212` base, `#1e1e1e` surface, lighter text
- All UI components use `var(--color-*)` tokens
- Stage B can extend token system for editor/lint features

#### Testing
- Playwright e2e: toggle switches theme, persists after reload
- Visual verification: all tables, badges, banners readable in both themes

### Testing
- All existing tests remain green (92 unit + 3 e2e = 95 total)
- New: `test/windows-fixes.test.ts` (7 tests)
- Updated: `test/e2e/ui.spec.ts` (4 tests, +1 theme test)
- Total: 99 unit + 4 e2e = 103 tests passing

---

### Fixed - Default policy and removed-server tracking (2026-09-25)

#### Commander default prevented per-server fallback
- **Problem:** `--keep-hot` had commander default "5", so `opts.keepHot` was always set even when user provided no flags. The per-server fallback never ran, causing plain `emit` to drop servers.
- **Fix:** Removed commander default from `--keep-hot` and other keep flags. Defaults now applied in code only after determining no explicit policy was given.
- **Result:** Plain `emit` with no flags now correctly uses per-server keep-2 default, keeping all servers.

#### Servers with zero hot tools not tracked as removed
- **Problem:** Servers dropped due to having zero hot tools (after policy application) were not counted in `savings.removedServers` / `removedServersCount`, and no warning printed. `apply` showed servers removed but report.json showed 0.
- **Fix:** `buildProposedMcpConfig` now returns all removed servers (both explicit and zero-hot). Warning prints for any server removal with appropriate reason. Savings tracks all removed servers consistently.
- **Result:** Removed servers always reported and warned about, regardless of removal reason.

#### Regression tests
- CLI child-process tests verify plain `emit` keeps all 4 servers with ≥2 hot tools each
- Tests verify explicit global policy drops servers and reports them correctly
- Tests verify zero-hot servers are tracked as removed with proper warnings

### Fixed - Live-run bugs (2026-09-24)

#### Bug 1: Default emit no longer drops whole servers
- **Default behavior changed:** Per-server keeping is now the default. Every server present in the source config stays in the proposed config with at least its 2 cheapest tools hot (configurable via `--keep-per-server`).
- Global `--keep-hot` and `--disable-servers-over` are explicit opt-ins that may remove servers.
- Loud warning printed when servers are removed, listing which servers and why.
- Savings reporting now separates deferred-tool savings from removed-server savings in report.json and other outputs.

#### Bug 2: Secrets no longer leak into proposed configs
- All `env` and `headers` values in emitted files (proposed mcp.json, reports, SARIF, HTML) are replaced with the sentinel `<from-original>`.
- `apply` restores sentinel values from the source mcp.json at write time.
- `apply` errors (non-zero exit, clear message) if any sentinel key cannot be resolved in the original config.
- Test coverage ensures planted secret values never appear in any output.

#### Bug 3: `apply --dry-run` flag now accepted
- `--dry-run` is now an explicit flag for the `apply` command (matches documented behavior).
- `apply` is dry-run by default; `--dry-run` combined with `--yes` produces a clear error.
- README and help text updated for consistency.

### Added - Live-run fixes
- Live-shaped fixture (`tools-live-shaped.json`) with 120+ tools across 4 servers for regression testing.
- Comprehensive test suite for all three bugs (9 new tests).
- 65 tests total (56 original + 9 new), all passing.

## [1.0.0] - 2026-09-23

### Added - Polish Pass

#### Demo & Documentation
- **Animated GIF demo** (`demos/schema-budget-demo.gif`) showcasing bloated fixture analysis and savings
- VHS tape script (`demos/tape.tape`) for reproducible demo recording
- README embedded GIF above text demo output

#### SARIF Output
- `analyze --format sarif` outputs SARIF 2.1.0 format for GitHub Code Scanning
- `analyze --sarif <path>` writes SARIF report to file
- Stable rule IDs: `schema-budget/tool-too-large`, `schema-budget/over-budget`, etc.
- Full SARIF test coverage on bloated fixtures
- Compatible with GitHub Actions `upload-sarif` / artifact upload

#### HTML Report Polish
- **Savings banner** with current/proposed/saved tokens and percentage reduction
- **Top offenders table** showing ranked tools with lint hit counts
- Clear call-to-action with proposed config path (`mcp.json.schema-budget-proposed.json`)
- Improved styling with gradients and responsive grid layout
- Maintained secret redaction rules

#### Watch Mode
- `analyze --watch` flag to monitor config and tools JSON files
- Debounced file watching (~300ms) to prevent excessive re-runs
- Automatic re-analysis on file changes
- Clean Ctrl+C exit handling
- Works with all analyze flags (--html, --sarif, --json, etc.)

### Technical
- New `formatSarif()` formatter with SARIF 2.1.0 schema compliance
- `debounce()` utility for file watching
- Enhanced `formatHtml()` with savings summary and offenders section
- Node.js `fs.watch` integration for cross-platform file monitoring
- 56 passing tests (12 test files)

## [1.2.0-stage-a] - 2026-09-25

### Added - Schema Budget v1.2 Stage A

#### Live Polling
- `--watch-interval <sec>` flag for `analyze --watch` (default 30, minimum 10)
- Automatic re-discovery of stdio servers on every tick
- Diff tracking between polling ticks:
  - Servers added/removed/status changed
  - Tools added/removed/changed with token deltas
  - Per-server and total token deltas
- Non-overlapping tick guarantee: skips a tick if previous is still running
- Clean process cleanup on exit and SIGINT
- Compact change summary printed to CLI only when something changed

#### Local Web GUI (`schema-budget ui`)
- New `ui [config]` command starts a local HTTP server with React dashboard
- Security-first design:
  - Binds to `127.0.0.1` only (never `0.0.0.0`)
  - Random port by default, `--port` optional
  - One-time session token required on every API call (401 without valid token)
  - Host header validation (DNS-rebinding defense)
  - No permissive CORS
  - All secrets redacted to `<from-original>` in API responses and SSE events
- Options:
  - `--no-open` to print URL instead of auto-opening browser
  - `--watch-interval <sec>` for polling frequency (default 30, min 10)
  - `--tools-json` and `--timeout` work as expected
- API endpoints:
  - `GET /api/health` — server health check
  - `GET /api/report` — current analysis snapshot
  - `GET /api/events` — Server-Sent Events for live updates
- React + TypeScript GUI with Vite build pipeline
  - Total tokens + savings banner (for default proposal)
  - Per-server table: status, tool count, tokens, lint findings (sortable)
  - Top 10 tools by token cost
  - Lint summary with severity badges and suggestions
  - Live change feed showing diffs as they arrive
  - "Last updated" timestamp
- GUI bundled into npm package at `dist/gui/` (works from `npx`)
- No browser-side tokenization: all numbers come from CLI core via API

#### Build & Packaging
- `gui/` directory: standalone Vite + React app with own package.json
- Root build runs `build:cli` then `build:gui`
- `dist/gui/` included in package `files`
- Verified with `npm pack` that GUI assets ship correctly

#### Testing
- **Security tests** (`test/security.test.ts`):
  - Localhost-only binding verified
  - 401 without token or with wrong token
  - 403 for invalid Host header
  - Planted secret never appears in API responses
- **Polling diff tests** (`test/poll.test.ts`):
  - Added/removed/changed servers and tools
  - Token delta calculations (total and per-server)
  - Null diff when nothing changed
  - No overlapping ticks (unit-tested logic)
- **Playwright e2e test** (`test/e2e/ui.spec.ts`):
  - Loads dashboard on a fixture
  - Verifies servers and totals displayed
  - Checks top offenders table visible
- All existing 56 tests remain green
- New test count: **69 unit tests + 3 e2e tests = 72 total**

#### Documentation
- Committed spec to `docs/superpowers/specs/2026-09-25-schema-budget-v1.2-gui-polling.md`
- README updated with "GUI (preview)" section and commands table
- CHANGELOG entry for Stage A

### Technical
- TypeScript ESM throughout
- Node HTTP server (no dependencies for server itself)
- React 18 + Vite 6 for GUI
- Polling controlled by `Poller` class with non-overlapping ticks
- Diff engine in `src/poll/differ.ts`
- API server in `src/ui/server.ts`
- Shared types between CLI and GUI (`gui/src/types.ts` mirrors `src/types.ts`)

### Future Considerations
- Stage B: Editor + lint drill-down + export (PR 2)
- Stage C: Apply from GUI (PR 3)
- Direct npm registry publication (on hold pending approval)

## [1.2.0-stage-b] - 2026-09-25

### Added - Schema Budget v1.2 Stage B

#### Editor & Proposal System
- **Policy Editor** component with live proposal generation:
  - Per-tool keep/defer checkboxes for granular control
  - Per-server "keep N cheapest" controls
  - Global policy controls: keep-hot, keep-per-server, disable-servers-over
  - Preset buttons: Aggressive (1/server), Default (2/server), Minimal (3/server)
  - Real-time savings calculation and display
  - Warning banner when any server would have zero kept tools (removal warning)
- **POST /api/proposal** endpoint:
  - Accepts policy from browser, returns proposal + savings + removed servers
  - CLI-parity verified: same proposal as `schema-budget emit` for identical policy
  - Secrets always redacted to `<from-original>` in proposed config
- **POST /api/export** endpoint:
  - Writes same files as `emit`: report.json, keep proposal, defer hints, proposed config
  - Never overwrites user's mcp.json (uses `.schema-budget-proposed.json` suffix)
  - Includes `<from-original>` sentinel in all outputs
  - Client-scoped: requires valid client ID (no browser-supplied paths accepted)

#### Client Auto-Detection
- **GET /api/clients** endpoint lists all detected MCP client configs:
  - Cursor (global `~/.cursor/mcp.json` + project `.cursor/mcp.json`)
  - Claude Desktop (OS-specific paths: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%/Claude/...`, Linux `~/.config/Claude/...`)
  - Claude Code (global `~/.claude.json` + project `.mcp.json`)
  - VS Code (OS-specific `settings.json` paths)
  - Windsurf, Antigravity, Gemini CLI (OS-specific)
- **Client selector** in GUI header:
  - Auto-selects first detected client
  - Browser picks by client ID only (server validates against detected list)
  - View-only mode for clients without emit profile (VS Code, Windsurf, etc.)
  - Export disabled for view-only clients
- **Security:** All config paths researched from official vendor docs (cited in code); browser never supplies filesystem paths

#### Lint Drill-Down
- **LintDrillDown** component with detailed finding inspection:
  - Severity filters: All, Error, Warn, Info
  - Expandable findings showing:
    - Rule ID, severity, server::tool
    - Suggestion text (static, no LLM)
    - Tool token breakdown (name, description, schema)
    - Share of server percentage
  - "No findings" success state for clean schemas

#### Settings Panel
- **Settings** overlay with persistent localStorage:
  - **Theme toggle:** Light / Dark / System (respects prefers-color-scheme)
  - **Refresh interval:** Configurable seconds (min 10), saved client-side
  - **Default policy:** Keep-per-server and keep-hot defaults
- CSS dark mode via `[data-theme="dark"]` with complete color variable set
- Existing theme system moved into settings panel (no regression)

#### Navigation & Layout
- **Header navigation:** Dashboard, Editor, Lint tabs
- **Settings button:** Gear icon (⚙️) in header
- **Client selector:** Dropdown showing detected clients with view-only badges
- Three-view application:
  - Dashboard (existing Stage A, untouched)
  - Editor (new)
  - Lint (drill-down view)

#### Security (Stage B additions)
- **POST security checks:**
  - Origin header validation (rejects cross-origin requests)
  - Content-Type enforcement (requires `application/json`)
  - Token auth on all POST endpoints (401 without valid token)
  - Host header check remains enforced
- **Client path security:**
  - Browser never sends filesystem paths
  - Server validates client ID against detected list
  - Unknown client IDs rejected with 404
  - Browser-supplied paths explicitly rejected (never trusted)
- **Export safety:**
  - View-only clients rejected with 403
  - Secrets always `<from-original>` in all outputs
  - Never overwrites mcp.json

#### Testing
- **New tests** (`test/stage-b.test.ts`):
  - GET /api/clients returns clients without exposing paths to browser
  - POST /api/proposal generates valid proposal with CLI parity
  - POST /api/proposal rejects without valid token
  - POST /api/proposal rejects cross-origin requests
  - POST /api/proposal requires JSON content-type
  - POST /api/export rejects unknown client ID
  - POST /api/export rejects without clientId
  - POST /api/export rejects cross-origin requests
  - Client detection without exposing paths
  - Unknown client ID returns null
  - Zero-kept tools warning test (servers removed when no hot tools)
  - API proposal matches CLI emit proposal (CLI-parity test)
- **Playwright e2e tests** (`test/e2e/ui.spec.ts`):
  - Navigates to Editor tab
  - Editor shows policy controls and presets
  - Editor shows tools with checkboxes
  - Editor updates savings when policy changes
  - Opens and closes settings panel
  - Settings panel has theme controls
  - Navigates to Lint tab
- **Test counts:**
  - Unit tests: 97 passing (85 original + 12 new Stage B)
  - E2e tests: 10 passing (3 original + 7 new Stage B)

#### Documentation
- README updated with Stage B features
- Client config paths documented in `src/discover/clientConfigs.ts` with official vendor sources
- CHANGELOG entry for Stage B

### Technical
- TypeScript ESM throughout (no regressions)
- React components: Editor, Settings, LintDrillDown
- CSS dark mode with CSS variables
- Client config auto-detection with OS-aware paths (Windows/macOS/Linux)
- localStorage for settings persistence
- POST endpoint security layer (Origin, Content-Type, token)

### Fixed
- **Windows test fix (commit 1):** Error message prefix for handshake_failed result path now includes command name, making integration test `missing binary spawns fails` pass on Windows (was only applied on exception path before)

### Breaking Changes
None — Stage B is purely additive; all Stage A functionality preserved
