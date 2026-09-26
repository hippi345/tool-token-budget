export async function pollUntil(
  fn: () => Promise<boolean>,
  opts?: { timeoutMs?: number; intervalMs?: number; label?: string }
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const intervalMs = opts?.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) {
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(opts?.label ?? `Timed out after ${timeoutMs}ms`);
}
