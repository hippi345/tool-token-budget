import type { SnapshotEvent } from "./api";

export interface SseParseState {
  /** Bytes already consumed from XMLHttpRequest.responseText */
  readOffset: number;
  /** Incomplete SSE event waiting for trailing blank line */
  buffer: string;
}

export function createSseParseState(): SseParseState {
  return { readOffset: 0, buffer: "" };
}

/** Parse newly arrived SSE bytes; each complete event is returned once, in order. */
export function appendSseResponseText(
  state: SseParseState,
  responseText: string
): SnapshotEvent[] {
  const chunk = responseText.slice(state.readOffset);
  state.readOffset = responseText.length;
  state.buffer += chunk;

  const events: SnapshotEvent[] = [];
  const parts = state.buffer.split("\n\n");
  state.buffer = parts.pop() ?? "";

  for (const block of parts) {
    if (!block.startsWith("data: ")) {
      continue;
    }
    try {
      events.push(JSON.parse(block.slice(6)) as SnapshotEvent);
    } catch {
      // skip malformed blocks
    }
  }
  return events;
}
