# Local client tool-call logs (Stage 3b)

Tool Token Budget scans **read-only** local logs to count MCP tool invocations. Output includes **tool names and counts only** — never log line bodies, arguments, or secrets.

## Clients implemented

| Client | Why included |
| --- | --- |
| **Claude Code** | Documented append-only JSONL under `~/.claude/projects/`; MCP tools use stable `mcp__<server>__<tool>` names in `tool_use` blocks. |
| **Codex CLI** | Rollout JSONL under `~/.codex/sessions/`; MCP-style names on `function_call` / `custom_tool_call` payload lines (OpenAI Codex CLI storage). |
| **Cursor** | Agent transcript JSONL under `~/.cursor/projects/.../agent-transcripts/`; same `tool_use` shape as Claude for MCP names. File mtime used when lines lack timestamps. |

## Not implemented

| Client | Why skipped |
| --- | --- |
| **VS Code (Copilot / MCP)** | No stable, documented on-disk MCP tool-call log format. Chat/state lives in SQLite (`state.vscdb`) without a public MCP invocation schema — we do not guess. |

## Log paths by platform

Paths below use `$HOME` / `%USERPROFILE%` / `~` as documented by each client. Override roots in tests with `--usage-log-dir` (expects `claude-code/`, `codex/`, and `cursor/` subdirectories).

### Claude Code

| OS | Path |
| --- | --- |
| Windows | `%USERPROFILE%\.claude\projects\<encoded-project>\<session-uuid>.jsonl` |
| macOS | `~/.claude/projects/<encoded-project>/<session-uuid>.jsonl` |
| Linux | `~/.claude/projects/<encoded-project>/<session-uuid>.jsonl` |

### Codex CLI

`CODEX_HOME` defaults to `~/.codex` (Windows: `%USERPROFILE%\.codex`).

| OS | Path |
| --- | --- |
| Windows | `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl` |
| macOS | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Linux | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |

### Cursor

| OS | Path |
| --- | --- |
| Windows | `%USERPROFILE%\.cursor\projects\<project-slug>\agent-transcripts\**\*.jsonl` |
| macOS | `~/.cursor/projects/<project-slug>/agent-transcripts/**/*.jsonl` |
| Linux | `~/.cursor/projects/<project-slug>/agent-transcripts/**/*.jsonl` |

## CLI flags

- `--since <window>` — default `30d`; also accepts an ISO calendar date.
- `--no-usage` — skip log scan (schema-only analyze/emit).
- `--usage-log-dir <dir>` — point at synthetic fixtures or a copied log tree.
