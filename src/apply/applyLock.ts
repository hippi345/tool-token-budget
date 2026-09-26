import { open, readFile, unlink, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import {
  lockPathForConfig,
  legacyLockPathForConfig,
} from "../branding/artifactPaths.js";

const LOCK_STALE_MS = 5 * 60 * 1000;

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const st = await stat(lockPath);
    return Date.now() - st.mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function clearStaleLockIfNeeded(lockPath: string): Promise<boolean> {
  try {
    await readFile(lockPath, "utf8");
  } catch {
    return false;
  }
  if (await isStaleLock(lockPath)) {
    try {
      await unlink(lockPath);
    } catch {
      // ignore
    }
    return false;
  }
  return true;
}

export class ApplyLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyLockError";
  }
}

/**
 * Exclusive lock next to the live mcp config (O_EXCL). Honors legacy lock files.
 */
export async function withApplyFileLock<T>(
  mcpConfigPath: string,
  fn: () => Promise<T>
): Promise<T> {
  const lockPath = lockPathForConfig(mcpConfigPath);
  const legacyLockPath = legacyLockPathForConfig(mcpConfigPath);
  let acquired = false;

  if (await clearStaleLockIfNeeded(legacyLockPath)) {
    throw new ApplyLockError(
      `Config is locked by another apply (lockfile: ${legacyLockPath}). Wait and retry.`
    );
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (await clearStaleLockIfNeeded(lockPath)) {
      throw new ApplyLockError(
        `Config is locked by another apply (lockfile: ${lockPath}). Wait and retry.`
      );
    }
    try {
      const fd = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL);
      await fd.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n",
        "utf8"
      );
      await fd.close();
      acquired = true;
      break;
    } catch (err: unknown) {
      const code = err && typeof err === "object" && "code" in err ? (err as { code: string }).code : "";
      if (code === "EEXIST") {
        if (await isStaleLock(lockPath)) {
          try {
            await unlink(lockPath);
          } catch {
            // another winner may have removed it
          }
          continue;
        }
        throw new ApplyLockError(
          `Config is locked by another apply (lockfile: ${lockPath}). Wait and retry.`
        );
      }
      throw err;
    }
  }

  if (!acquired) {
    throw new ApplyLockError(`Could not acquire apply lock at ${lockPath}`);
  }

  try {
    return await fn();
  } finally {
    try {
      await unlink(lockPath);
    } catch {
      // best effort
    }
  }
}

export async function readLockPath(mcpConfigPath: string): Promise<string | null> {
  for (const lockPath of [
    lockPathForConfig(mcpConfigPath),
    legacyLockPathForConfig(mcpConfigPath),
  ]) {
    try {
      await readFile(lockPath, "utf8");
      return lockPath;
    } catch {
      // try next
    }
  }
  return null;
}
