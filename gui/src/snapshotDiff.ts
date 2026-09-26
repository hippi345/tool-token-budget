import type { SnapshotEvent } from "./api";

export function isSerializedDiffEmpty(diff: SnapshotEvent["diff"]): boolean {
  if (!diff) {
    return true;
  }
  return (
    diff.servers.added.length === 0 &&
    diff.servers.removed.length === 0 &&
    diff.servers.statusChanged.length === 0 &&
    diff.tools.added.length === 0 &&
    diff.tools.removed.length === 0 &&
    diff.tools.changed.length === 0 &&
    diff.tokens.total === 0
  );
}
