/** Parse optional non-negative integer from a number input; preserves 0 (unlike `parseInt(x) || undefined`). */
export function parseOptionalPolicyInt(raw: string): number | undefined {
  if (raw === "") return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}
