import { rename } from "node:fs/promises";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function isTransientRenameError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && RETRY_CODES.has(code);
}

export type RenameFn = (from: string, to: string) => Promise<void>;

export async function renameWithRetry(
  from: string,
  to: string,
  opts?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    renameFn?: RenameFn;
  }
): Promise<void> {
  const maxAttempts = opts?.maxAttempts ?? 12;
  const baseDelayMs = opts?.baseDelayMs ?? 20;
  const doRename = opts?.renameFn ?? rename;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientRenameError(err) || attempt === maxAttempts - 1) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}
