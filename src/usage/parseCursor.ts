import { parseClaudeCodeJsonlLine } from "./parseClaudeCode.js";

/**
 * Cursor agent-transcript JSONL uses the same assistant/tool_use shape as Claude Code
 * for tool calls (documented by multiple transcript adapters).
 */
export function parseCursorJsonlLine(
  line: string,
  sinceMs: number,
  fileMtimeMs: number,
  counts: Map<string, number>
): void {
  parseClaudeCodeJsonlLine(line, sinceMs, fileMtimeMs, counts);
}

export function parseCursorJsonlContent(
  content: string,
  sinceMs: number,
  fileMtimeMs: number,
  counts: Map<string, number>
): void {
  for (const line of content.split("\n")) {
    parseCursorJsonlLine(line, sinceMs, fileMtimeMs, counts);
  }
}
