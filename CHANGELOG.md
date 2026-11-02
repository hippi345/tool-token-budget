# Changelog

All notable changes to **Tool Token Budget** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-02

### Changed

- README opens with the demo GIF, a one-line "why", and real sample `analyze` output (#11).
- Docs: GitHub Copilot added to the GUI auto-detect client list (#6); `--profile` flag values fixed (#5).
- CI: npm publish is skipped when the version is already on the registry (#4).
- Dependencies: @modelcontextprotocol/sdk 1.32.2 (#8), @decimalturn/toml-patch 3.3.1 (#7), @playwright/test 1.64.1 (#9), @testing-library/react 16.3.3 (#10).

## [1.0.0] - 2026-09-29

First stable release under the **Tool Token Budget** name (`tool-token-budget` on npm). The CLI binary `schema-budget` remains a backward-compatible alias for existing installs and scripts.

### Highlights

- **Measure** MCP tool schema token cost with deterministic `o200k_base` estimates (`js-tiktoken`), plus optional per-model columns via `@huggingface/tokenizers`.
- **Lint** bloat (description length, schema size, huge enums, deep nesting, duplicate boilerplate) with configurable `--fail-on` severity.
- **Emit** sibling artifacts only — `report.json`, `defer-hints.json`, `tool-token-budget.keep.json`, and optional proposed config — never overwriting live `mcp.json`.
- **Apply** proposed configs with dry-run by default, backups, and secret restoration from the original file.
- **Local web GUI** (`ui`): dashboard, policy editor, lint drill-down, live SSE polling, export, and apply preview — bound to `127.0.0.1` with token auth.
- **CI-friendly** outputs: JSON, HTML, SARIF 2.1.0, budget exit codes, and `lint-server` author mode.
- **Client discovery** for Cursor, Claude Desktop/Code, VS Code, Windsurf, Antigravity, Gemini CLI, and OpenAI Codex (`config.toml`), with `sync` between clients.
- **Usage-aware** ranking from local Claude Code, Codex, and Cursor logs (read-only).
- **Analyze history** and configurable token budgets with GUI chart support.

### Security & privacy

- Offline-first: no LLM, no cloud uploads.
- Env/header values redacted in reports; proposed configs use `<from-original>` sentinels restored on apply.
- GUI export paths are server-controlled; browser cannot supply filesystem paths.

### Requirements

- Node.js **>= 20**
