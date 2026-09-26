# Per-model token counts (Stage 1 — Feature 5)

Tool Token Budget can estimate or count tool schema tokens **per model family** and **per client framing** (how each IDE serializes MCP tools).

## Tokenizer packaging

**Choice: optional peer dependency + lazy cache (no bundled HF weights).**

- OpenAI-family exact counts ship with the default install via `js-tiktoken` (`o200k_base`, `cl100k_base`).
- Llama / Qwen / Mistral exact counts use **`@huggingface/tokenizers` as an optional peer** (`peerDependenciesMeta.optional`). The default npm install stays small; install the peer when you need exact open-weight counts.
- On first use, tokenizer JSON for **curated ungated Hugging Face repos** may be downloaded (60s timeout) into `~/.cache/tool-token-budget/tokenizers/` (override with `--cache-tokenizers`). Downloads use the built-in allowlist only; nothing is written outside the cache directory. Offline with a warm cache remains exact; with no peer, no cache, and no network, counts fall back to **labeled estimates** (use `--verbose` for a one-line reason; never crash).

## Client framing assumptions

| Framing | Used for | Serialized shape (v1) |
|---------|----------|------------------------|
| `anthropic-tools` | Claude Desktop / Code | `{ name, description, input_schema }` per tool |
| `openai-tools` | OpenAI Chat Completions | `{ type: "function", function: { name, description, parameters } }` |
| `vscode-flat` | VS Code internal (legacy flat) | `{ name, description, parameters }` without `type` wrapper |
| `gemini-functions` | Gemini CLI / Antigravity | One request-level `{ tools: [{ functionDeclarations: [...] }] }` wrapper |
| `cursor-catalog` | Cursor (default column) | Compact catalog heuristic (names + short schema refs) — **experimental** |
| `cursor-full` | Cursor worst-case | Full name + description + schema (legacy meter) |

The dashboard **Total Tokens** card and CLI ranked table use the legacy `estTokens` column: **sum of separate o200k estimates** for name, description, and schema fields. The `openai:o200k` preset uses the same per-tool numbers so its total matches that column. Other framings (e.g. joined `cursor-full` strings or `cursor-catalog` shared payloads) can differ.

`cursor-catalog` counts the catalog JSON **once** and attributes each tool its marginal share (catalog with all tools minus catalog without that tool).

Rank order of tools uses the legacy `estTokens` column unless you change sorting; per-model totals can differ while order stays stable.

## CLI flags

```bash
tool-token-budget analyze --tools-json fixtures/tools-bloated.json \
  --model claude-sonnet-4-5 \
  --models gpt-4o,gemini-2.0-flash \
  --count-mode offline \
  --framing anthropic-tools \
  --cache-tokenizers ~/.cache/tool-token-budget/tokenizers \
  --api-count-max 20
```

- `--count-mode offline|api|auto` — `auto` uses Anthropic `count_tokens` / Gemini `countTokens` only when the respective env key is set.
- `--api-count-max <n>` — hard cap on **HTTP requests** to token-count APIs for the whole run (default 20). Further models fall back to labeled offline counts.
- `--verbose` — one-line stderr reasons when HuggingFace exact tokenizers are unavailable.
- Env vars are read only: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (never logged; `doctor` shows booleans only).

### GUI `POST /api/model-counts`

`modelIds` must be a **non-empty array of strings** (max **16**). Each id must match a preset from `GET /api/model-presets`. Non-array bodies, invalid entries, unknown ids, or lists over 16 return HTTP 400 with `{ "error": "..." }`.

## report.json

Additive field `tokenCountsByModel` plus optional `countsByModel` on each tool row. Legacy `tokenizerId` and `estTokens` are unchanged for default runs.
