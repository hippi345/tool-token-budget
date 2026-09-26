import os from "node:os";
import path from "node:path";

export type UsageClientId = "claude-code" | "codex" | "cursor";

export interface UsageLogRoots {
  claudeCode: string;
  codex: string;
  cursor: string;
}

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/** Default log roots (override in tests via --usage-log-dir). */
export function defaultUsageLogRoots(): UsageLogRoots {
  const home = homeDir();
  const platform = process.platform;

  let claudeCode: string;
  let codex: string;
  let cursor: string;

  if (platform === "win32") {
    claudeCode = path.join(home, ".claude", "projects");
    codex = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "sessions");
    cursor = path.join(home, ".cursor", "projects");
  } else if (platform === "darwin") {
    claudeCode = path.join(home, ".claude", "projects");
    codex = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "sessions");
    cursor = path.join(home, ".cursor", "projects");
  } else {
    claudeCode = path.join(home, ".claude", "projects");
    codex = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "sessions");
    cursor = path.join(home, ".cursor", "projects");
  }

  return { claudeCode, codex, cursor };
}

/** Documented paths for docs/usage-log-sources.md (not necessarily identical to runtime on every OS). */
export function documentedLogPaths(): Record<
  UsageClientId,
  { win32: string; darwin: string; linux: string; note?: string }
> {
  return {
    "claude-code": {
      win32: "%USERPROFILE%\\.claude\\projects\\<encoded-project>\\<session-uuid>.jsonl",
      darwin: "~/.claude/projects/<encoded-project>/<session-uuid>.jsonl",
      linux: "~/.claude/projects/<encoded-project>/<session-uuid>.jsonl",
      note: "Append-only session transcripts; MCP tools appear as tool_use names mcp__<server>__<tool>.",
    },
    codex: {
      win32: "%USERPROFILE%\\.codex\\sessions\\YYYY\\MM\\DD\\rollout-*.jsonl",
      darwin: "~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl",
      linux: "~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl",
      note: "Rollout JSONL; MCP calls use payload.type function_call/custom_tool_call with MCP-style names.",
    },
    cursor: {
      win32: "%USERPROFILE%\\.cursor\\projects\\<project-slug>\\agent-transcripts\\**\\*.jsonl",
      darwin: "~/.cursor/projects/<project-slug>/agent-transcripts/**/*.jsonl",
      linux: "~/.cursor/projects/<project-slug>/agent-transcripts/**/*.jsonl",
      note: "Agent transcript JSONL; MCP tool_use names follow mcp__<server>__<tool>. Lines often lack timestamps — file mtime used.",
    },
  };
}
