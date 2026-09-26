import { parseMcpToolName, usageCountKey } from "./mcpToolName.js";

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

export function parseCodexJsonlLine(
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

  if (record.type !== "response_item") {
    return;
  }
  const payload = record.payload;
  if (!payload || typeof payload !== "object") {
    return;
  }
  const p = payload as { type?: string; name?: string };
  if (p.type !== "function_call" && p.type !== "custom_tool_call") {
    return;
  }
  if (typeof p.name !== "string") {
    return;
  }
  const parsed = parseMcpToolName(p.name);
  if (parsed) {
    const key = usageCountKey(parsed.server, parsed.tool);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

export function parseCodexJsonlContent(
  content: string,
  sinceMs: number,
  fileMtimeMs: number,
  counts: Map<string, number>
): void {
  for (const line of content.split("\n")) {
    parseCodexJsonlLine(line, sinceMs, fileMtimeMs, counts);
  }
}
