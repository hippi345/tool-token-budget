import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTokenizerCacheDir } from "./tokenizerCache.js";
import { logMeterVerbose } from "./meterVerbose.js";

export type HfTokenCounter = (text: string) => number;

const hfCounters = new Map<string, HfTokenCounter>();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..", "..");

const HF_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Env vars checked for Hugging Face Hub auth (gated models). */
export const HF_HUB_TOKEN_ENV_VARS = ["HF_TOKEN", "HUGGINGFACE_HUB_TOKEN"] as const;

/** Bundled tokenizer dirs (no network) keyed by hfTokenizerId. */
const BUNDLED_TOKENIZER_DIRS: Record<string, string> = {
  "fixture-tiny-bpe": path.join(PKG_ROOT, "fixtures", "tokenizers", "tiny-bpe"),
};

/** Known tokenizer.json URLs for curated models (lazy download when network available). */
const HF_TOKENIZER_URLS: Record<string, string> = {
  "meta-llama/Llama-3.1-8B":
    "https://huggingface.co/meta-llama/Llama-3.1-8B/resolve/main/tokenizer.json",
  "Qwen/Qwen2.5-7B":
    "https://huggingface.co/Qwen/Qwen2.5-7B/resolve/main/tokenizer.json",
  "mistralai/Mistral-7B-v0.1":
    "https://huggingface.co/mistralai/Mistral-7B-v0.1/resolve/main/tokenizer.json",
};

export type HfDownloadFn = (url: string) => Promise<Uint8Array>;

let downloadFn: HfDownloadFn | undefined;

let peerInstalledCheck: (() => Promise<boolean>) | undefined;

let hfDownloadCallCount = 0;

export function setHfDownloadFn(fn: HfDownloadFn | undefined): void {
  downloadFn = fn;
}

/** Test hook: override optional peer detection. */
export function setHfPeerInstalledCheck(fn: (() => Promise<boolean>) | undefined): void {
  peerInstalledCheck = fn;
}

export function resetHfDownloadCallCount(): void {
  hfDownloadCallCount = 0;
}

export function getHfDownloadCallCount(): number {
  return hfDownloadCallCount;
}

const ALLOWED_DOWNLOAD_URLS = new Set(Object.values(HF_TOKENIZER_URLS));

export function readHfHubToken(): string | undefined {
  for (const key of HF_HUB_TOKEN_ENV_VARS) {
    const v = process.env[key];
    if (v && v.trim()) {
      return v.trim();
    }
  }
  return undefined;
}

export class HfDownloadHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function defaultHfDownload(url: string): Promise<Uint8Array> {
  if (!ALLOWED_DOWNLOAD_URLS.has(url)) {
    throw new Error("tokenizer URL not on curated allowlist");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HF_DOWNLOAD_TIMEOUT_MS);
  const token = readHfHubToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) {
      throw new HfDownloadHttpError(res.status, `HTTP ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } finally {
    clearTimeout(timer);
  }
}

function resolveDownloadFn(): HfDownloadFn | undefined {
  return downloadFn ?? defaultHfDownload;
}

function bundledDir(hfTokenizerId: string): string | null {
  return BUNDLED_TOKENIZER_DIRS[hfTokenizerId] ?? null;
}

async function readTokenizerPair(
  dir: string
): Promise<{ tokenizerJson: object; tokenizerConfig: object } | null> {
  try {
    const tokenizerJson = JSON.parse(
      await readFile(path.join(dir, "tokenizer.json"), "utf8")
    ) as object;
    let tokenizerConfig: object = {};
    try {
      tokenizerConfig = JSON.parse(
        await readFile(path.join(dir, "tokenizer_config.json"), "utf8")
      ) as object;
    } catch {
      // tokenizer_config.json is optional for some bundles
    }
    return { tokenizerJson, tokenizerConfig };
  } catch {
    return null;
  }
}

function logHfVerbose(hfTokenizerId: string, reason: string): void {
  logMeterVerbose(`HF tokenizer unavailable for ${hfTokenizerId}: ${reason}`);
}

async function ensureTokenizerDir(
  hfId: string,
  cacheDir: string,
  peerInstalled: boolean
): Promise<{ dir: string | null; failure?: "peer-missing" | "gated" | "offline" }> {
  const bundled = bundledDir(hfId);
  if (bundled) {
    const pair = await readTokenizerPair(bundled);
    return { dir: pair ? bundled : null };
  }

  const safeName = hfId.replace(/[/\\:]/g, "_");
  const dir = path.join(cacheDir, safeName);
  const filePath = path.join(dir, "tokenizer.json");
  try {
    await readFile(filePath);
    return { dir };
  } catch {
    // missing cache file
  }

  if (!peerInstalled) {
    return { dir: null, failure: "peer-missing" };
  }

  const url = HF_TOKENIZER_URLS[hfId];
  const dl = resolveDownloadFn();
  if (!url || !dl) {
    return { dir: null, failure: "offline" };
  }
  try {
    hfDownloadCallCount += 1;
    const bytes = await dl(url);
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, bytes);
    return { dir };
  } catch (err) {
    if (err instanceof HfDownloadHttpError && (err.status === 401 || err.status === 403)) {
      return { dir: null, failure: "gated" };
    }
    return { dir: null, failure: "offline" };
  }
}

async function loadCounterFromDir(dir: string): Promise<HfTokenCounter | null> {
  const pair = await readTokenizerPair(dir);
  if (!pair) {
    return null;
  }
  try {
    const { Tokenizer } = await import("@huggingface/tokenizers");
    const tokenizer = new Tokenizer(pair.tokenizerJson, pair.tokenizerConfig);
    return (text: string) => {
      if (!text) return 0;
      return tokenizer.encode(text).ids.length;
    };
  } catch {
    return null;
  }
}

/**
 * Load HuggingFace tokenizer when `@huggingface/tokenizers` is installed (optional peer).
 * Falls back to null — caller should use o200k estimate.
 */
export async function getHfTokenCounter(
  hfTokenizerId: string,
  cacheDirOverride?: string
): Promise<HfTokenCounter | null> {
  const cacheKey = `${hfTokenizerId}:${cacheDirOverride ?? ""}`;
  const existing = hfCounters.get(cacheKey);
  if (existing) return existing;

  const peerInstalled = peerInstalledCheck
    ? await peerInstalledCheck()
    : await isHfTokenizersPeerInstalled();
  const cacheDir = resolveTokenizerCacheDir(cacheDirOverride);
  const ensured = await ensureTokenizerDir(hfTokenizerId, cacheDir, peerInstalled);

  if (!ensured.dir) {
    if (ensured.failure === "peer-missing") {
      logHfVerbose(
        hfTokenizerId,
        "peer not installed (npm i @huggingface/tokenizers)"
      );
    } else if (ensured.failure === "gated") {
      const envHint = HF_HUB_TOKEN_ENV_VARS.join(" or ");
      logHfVerbose(
        hfTokenizerId,
        `gated or unauthorized (set ${envHint} for Hugging Face Hub access)`
      );
    } else {
      logHfVerbose(
        hfTokenizerId,
        "offline or cache miss (use --cache-tokenizers with a warm cache)"
      );
    }
    return null;
  }

  const counter = await loadCounterFromDir(ensured.dir);
  if (!counter) {
    logHfVerbose(
      hfTokenizerId,
      "offline or cache miss (use --cache-tokenizers with a warm cache)"
    );
    return null;
  }

  hfCounters.set(cacheKey, counter);
  return counter;
}

export function resetHfTokenCounters(): void {
  hfCounters.clear();
}

/** Whether the optional @huggingface/tokenizers peer can be imported. */
export async function isHfTokenizersPeerInstalled(): Promise<boolean> {
  try {
    await import("@huggingface/tokenizers");
    return true;
  } catch {
    return false;
  }
}
