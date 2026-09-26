import { parseMcpToolName, usageCountKey } from "./mcpToolName.js";

function extractToolUsesFromAssistantMessage(msg: unknown): string[] {
  const names: string[] = [];
  if (!msg || typeof msg !== "object") {
    return names;
  }
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return names;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as { type?: string; name?: string };
    if (b.type === "tool_use" && typeof b.name === "string") {
      names.push(b.name);
    }
  }
  return names;
}

function lineTimestampMs(record: Record<string, unknown>): number | undefined {
  const ts = record.timestamp;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) {
      return ms;
    }
  }
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts > 1e12 ? ts : ts * 1000;
  }
  return undefined;
}

/** Parse one Claude Code JSONL line; returns MCP tool key if in window. */
export function parseClaudeCodeJsonlLine(
  line: string,
  sinceMs: number,
  fileMtimeMs: number,
  counts: Map<string, number>
): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }
  const ts = lineTimestampMs(record) ?? fileMtimeMs;
  if (ts < sinceMs) {
    return;
  }

  if (record.type === "assistant" && record.message) {
    for (const name of extractToolUsesFromAssistantMessage(record.message)) {
      const parsed = parseMcpToolName(name);
      if (parsed) {
        const key = usageCountKey(parsed.server, parsed.tool);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return;
  }

  const msg = record.message as { role?: string; content?: unknown } | undefined;
  if (msg?.role === "assistant") {
    for (const name of extractToolUsesFromAssistantMessage(msg)) {
      const parsed = parseMcpToolName(name);
      if (parsed) {
        const key = usageCountKey(parsed.server, parsed.tool);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
}

export function parseClaudeCodeJsonlContent(
  content: string,
  sinceMs: number,
  fileMtimeMs: number,
  counts: Map<string, number>
): void {
  for (const line of content.split("\n")) {
    parseClaudeCodeJsonlLine(line, sinceMs, fileMtimeMs, counts);
  }
}
