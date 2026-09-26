const seenLines = new Set<string>();

/** Log a single line once per distinct message (e.g. repeated poll load errors). */
export function logOnce(_key: string, line: string): void {
  if (seenLines.has(line)) {
    return;
  }
  seenLines.add(line);
  console.error(line);
}

/** @internal test helper */
export function resetLogOnceForTests(): void {
  seenLines.clear();
}
