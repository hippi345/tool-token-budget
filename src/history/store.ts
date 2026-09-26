import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Report } from "../types.js";
import type { AnalyzeHistoryEntry, AnalyzeHistoryFile } from "./types.js";
import {
  getAnalyzeHistoryFilePath,
  type UserStatePathDeps,
} from "../state/userStatePaths.js";
import { stripBOM } from "../utils/json.js";

export const TOOL_TOKEN_BUDGET_NO_HISTORY_ENV = "TOOL_TOKEN_BUDGET_NO_HISTORY";
export const DEFAULT_HISTORY_MAX_ENTRIES = 200;

export interface HistoryRecordContext {
  clientId?: string;
}

export interface HistoryWriteOptions {
  deps?: UserStatePathDeps;
  maxEntries?: number;
  historyFilePath?: string;
}

export function isHistoryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[TOOL_TOKEN_BUDGET_NO_HISTORY_ENV];
  return v === "1" || v === "true" || v === "yes";
}

export function buildHistoryEntryFromReport(
  report: Report,
  ctx: HistoryRecordContext = {}
): AnalyzeHistoryEntry {
  const byModel: Record<string, number> = {};
  if (report.tokenCountsByModel) {
    for (const [modelId, summary] of Object.entries(report.tokenCountsByModel)) {
      byModel[modelId] = summary.total;
    }
  } else {
    byModel[report.tokenizerId] = report.totals.estTokens;
  }

  const byClient: Record<string, number> = {};
  if (ctx.clientId) {
    byClient[ctx.clientId] = report.totals.estTokens;
  }

  return {
    at: report.generatedAt,
    totalTokens: report.totals.estTokens,
    byClient,
    byModel,
  };
}

export function parseHistoryFile(raw: string): AnalyzeHistoryFile | null {
  try {
    const parsed = JSON.parse(stripBOM(raw)) as AnalyzeHistoryFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readAnalyzeHistory(
  opts: { deps?: UserStatePathDeps; historyFilePath?: string } = {}
): Promise<{ file: AnalyzeHistoryFile; corrupt: boolean }> {
  const filePath = opts.historyFilePath ?? getAnalyzeHistoryFilePath(opts.deps);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = parseHistoryFile(raw);
    if (!parsed) {
      return { file: { version: 1, entries: [] }, corrupt: true };
    }
    return { file: parsed, corrupt: false };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { file: { version: 1, entries: [] }, corrupt: false };
    }
    return { file: { version: 1, entries: [] }, corrupt: true };
  }
}

function rotateEntries(
  entries: AnalyzeHistoryEntry[],
  maxEntries: number
): AnalyzeHistoryEntry[] {
  if (entries.length <= maxEntries) {
    return entries;
  }
  return entries.slice(entries.length - maxEntries);
}

export async function appendAnalyzeHistory(
  report: Report,
  ctx: HistoryRecordContext,
  opts: HistoryWriteOptions = {}
): Promise<void> {
  const env = opts.deps?.env ?? process.env;
  if (isHistoryDisabled(env)) {
    return;
  }

  const entry = buildHistoryEntryFromReport(report, ctx);
  const filePath = opts.historyFilePath ?? getAnalyzeHistoryFilePath(opts.deps);
  const { file, corrupt } = await readAnalyzeHistory({
    deps: opts.deps,
    historyFilePath: filePath,
  });
  if (corrupt) {
    console.error(`warn: analyze history file unreadable (${filePath}); starting fresh`);
  }

  const maxEntries = opts.maxEntries ?? DEFAULT_HISTORY_MAX_ENTRIES;
  const next: AnalyzeHistoryFile = {
    version: 1,
    entries: rotateEntries([...file.entries, entry], maxEntries),
  };

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(next, null, 2) + "\n", "utf8");
}
