# Testing

Tool Token Budget v1 includes comprehensive test coverage at multiple levels: unit tests, integration tests, and functional smoke tests.

## Running Tests

### Unit & Integration Tests

```bash
npm test
```

Runs the vitest suite covering:
- **Meter**: Token estimation and scoring
- **Lint**: Rule application and severity handling  
- **Emit**: Artifact generation (defer-hints, keep files)
- **Redaction**: Environment secret masking
- **Integration**: Live MCP server spawning, tools/list, secrets redaction in all report formats

Current coverage: 23 tests across 6 test files.

### Smoke Tests (Functional Regression)

```bash
npm run smoke:real
```

Comprehensive end-to-end CLI tests covering real-world usage:

| Test Category | Commands Tested | Expected Exit Codes |
|---------------|----------------|---------------------|
| **Doctor** | `doctor` | 0 (ok) |
| **Analyze fixtures** | `analyze --tools-json fixtures/*.json` | 0 (tiny, bloated, enums) |
| **Live stub (mcp.json)** | `analyze fixtures/mcp-with-secrets.json`<br>`analyze fixtures/mcp-mixed.json` | 0 (stub spawns, remotes warn+skip) |
| **Emit artifacts** | `emit --tools-json fixtures/tools-bloated.json --out <dir> --keep-hot 3` | 0 + 3 files created:<br>• report.json<br>• defer-hints.json<br>• tool-token-budget.keep.json |
| **Budget enforcement** | `analyze --budget 10` (over)<br>`analyze --budget 1000` (under) | 1 (over budget)<br>0 (under budget) |
| **Usage errors** | `analyze --invalid-flag-xyz`<br>`nonexistent-command` | 2 (usage error)<br>2 (usage error) |
| **Secrets redaction** | text / JSON / HTML reports from mcp-with-secrets.json | 0 + no secret values leaked |
| **Remote entries** | mcp-mixed.json with remote-sse, remote-http | 0 (warns + skips, no crash) |

**Exit codes summary**:
- `0` — success / under budget / no lint failures
- `1` — over budget / lint severity threshold hit
- `2` — usage error (bad flags, invalid config)

All tests must pass before merging.

## Test Fixtures

### Tools JSON Fixtures (offline)

- **`fixtures/tools-tiny.json`** — 2 tools, minimal schema (baseline)
- **`fixtures/tools-bloated.json`** — 5 tools with mega_search (3451 tokens), triggers lint warnings
- **`fixtures/tools-enums.json`** — 1 tool with 60-value enum, triggers huge-enum lint

### MCP Config Fixtures (live stdio)

- **`fixtures/mcp-with-secrets.json`** — Cursor-style mcpServers with:
  - `stub` server (node stub-mcp-server.mjs) with `SECRET_TOKEN`, `API_KEY` env vars
  - `remote-example` (remote/OAuth, should skip)
  
- **`fixtures/mcp-mixed.json`** — Mixed scenarios:
  - `stub` (ok, lists tools)
  - `missing-binary` (spawn fails, nonexistent command)
  - `remote-sse` (type: sse, should warn+skip)
  - `remote-http` (url, should warn+skip)

### Stub MCP Server

**`fixtures/stub-mcp-server.mjs`** — Minimal stdio MCP implementation responding to:
- `initialize` → returns protocol version, capabilities
- `notifications/initialized` → acknowledged
- `tools/list` → returns `[{ name: "stub_ping", description: "Stub ping tool", inputSchema: {...} }]`

Used by integration tests and smoke tests to verify live MCP discovery without network dependencies.

## E2E UI tests and `REAL_HOME`

Playwright e2e runs with `HOME` / `USERPROFILE` pointed at an isolated directory under `tmp/e2e-test-home` so apply/export never touch your real `~/.cursor/mcp.json`.

`test/e2e/playwright-loader.cjs` sets `process.env.REAL_HOME` from `os.userInfo().homedir`, which is **not** affected by those overrides. Guard tests in `test/e2e/ui.spec.ts` compare the fake home against `REAL_HOME` (and `REAL_HOME/.cursor`) to fail fast if isolation is misconfigured. The same loader reuses the real machine’s Playwright browser cache via `PLAYWRIGHT_BROWSERS_PATH`.

## Integration Test Coverage

**`test/integration.test.ts`** validates:

1. **Live stub spawning**: Spawn stub-mcp-server.mjs via mcp.json, list tools, meter successfully
2. **Mixed config handling**: 
   - stub server succeeds
   - missing binary fails gracefully (spawn_failed)
   - remote entries warn+skip (skipped_remote)
3. **Secrets redaction**: 
   - Text reports never contain secret env values
   - JSON reports never contain secret env values  
   - HTML reports never contain secret env values

All integration tests run against live stdio MCP servers with 10-15 second timeouts.

## CI Readiness

All tests are offline-first:
- No network calls (stub MCP uses local node process)
- No external API keys required
- Deterministic token estimates
- Fast: full test suite ~2s, smoke tests ~8s

Ready for GitHub Actions / Origin CI integration (post-v1).

## Adding New Tests

### Unit tests
Add to relevant `test/*.test.ts` file or create new test file. Use vitest describe/it/expect.

### Smoke tests
Add new command verification to `scripts/smoke.sh`:
```bash
node dist/cli.js <command> <args> > /dev/null 2>&1
check_exit <expected> $? "description"
```

### Fixtures
Add new fixture to `fixtures/` and reference in tests. Remember to redact secrets if adding MCP configs with env vars.
