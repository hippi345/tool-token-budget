import os from "node:os";
import path from "node:path";

/** Default HF tokenizer cache under user home (Windows-safe via os.homedir). */
export function defaultTokenizerCacheDir(): string {
  return path.join(os.homedir(), ".cache", "tool-token-budget", "tokenizers");
}

export function resolveTokenizerCacheDir(override?: string): string {
  if (override) {
    return path.resolve(override);
  }
  return defaultTokenizerCacheDir();
}
