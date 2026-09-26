import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKEN_HEX_LEN = 64;

/** Default UI session token cache under user home (Windows-safe via os.homedir). */
export function defaultUiAuthCacheDir(): string {
  return path.join(os.homedir(), ".cache", "tool-token-budget", "ui");
}

export function uiAuthTokenPath(port: number, cacheDir?: string): string {
  const dir = cacheDir ?? defaultUiAuthCacheDir();
  return path.join(dir, `auth-token-port-${port}.txt`);
}

function isValidTokenHex(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.length === TOKEN_HEX_LEN && /^[a-f0-9]+$/i.test(trimmed);
}

export function readPersistedUiAuthToken(port: number, cacheDir?: string): string | null {
  const filePath = uiAuthTokenPath(port, cacheDir);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (isValidTokenHex(raw)) {
      return raw.trim();
    }
  } catch {
    // missing or unreadable
  }
  return null;
}

export function writePersistedUiAuthToken(port: number, token: string, cacheDir?: string): void {
  const dir = cacheDir ?? defaultUiAuthCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = uiAuthTokenPath(port, cacheDir);
  fs.writeFileSync(filePath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows may not support chmod; ignore
  }
}

/**
 * Load or create the UI auth token for a bound port.
 * When `override` is set (tests), persistence is skipped.
 */
export function getOrCreatePersistedUiAuthToken(
  port: number,
  override?: string,
  cacheDir?: string
): string {
  if (override) {
    return override;
  }
  const existing = readPersistedUiAuthToken(port, cacheDir);
  if (existing) {
    return existing;
  }
  const token = randomBytes(32).toString("hex");
  writePersistedUiAuthToken(port, token, cacheDir);
  return token;
}
