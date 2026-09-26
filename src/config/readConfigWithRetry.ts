import { readFile } from "node:fs/promises";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function isTransientConfigReadError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && RETRY_CODES.has(code);
}

export type ReadFileFn = (path: string, encoding: "utf8") => Promise<string>;

/**
 * Read config bytes with short retries for Windows atomic-save races (EPERM/EBUSY/EACCES).
 * Opens and closes per attempt — no persistent handle.
 */
export async function readConfigUtf8WithRetry(
  filePath: string,
  opts?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    readFileFn?: ReadFileFn;
  }
): Promise<string> {
  const maxAttempts = opts?.maxAttempts ?? 8;
  const baseDelayMs = opts?.baseDelayMs ?? 15;
  const read = opts?.readFileFn ?? ((p, enc) => readFile(p, enc));

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await read(filePath, "utf8");
    } catch (err) {
      lastErr = err;
      if (!isTransientConfigReadError(err) || attempt === maxAttempts - 1) {
        throw err;
      }
      const delay = baseDelayMs * (attempt + 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
