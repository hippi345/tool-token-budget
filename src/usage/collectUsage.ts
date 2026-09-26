import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { UsageClientId, UsageLogRoots } from "./paths.js";
import { defaultUsageLogRoots } from "./paths.js";
import { parseClaudeCodeJsonlContent } from "./parseClaudeCode.js";
import { parseCodexJsonlContent } from "./parseCodex.js";
import { parseCursorJsonlContent } from "./parseCursor.js";
import { parseSinceOption, defaultSinceDays } from "./since.js";
import { usageCountKey } from "./mcpToolName.js";

export type UsageClientScanStatus = "ok" | "missing" | "unreadable";

export interface UsageClientScanResult {
  id: UsageClientId;
  status: UsageClientScanStatus;
  message?: string;
  /** Absolute paths scanned (names only in user output — no file contents). */
  scannedPaths: string[];
}

export interface UsageScanResult {
  sinceIso: string;
  windowDays: number;
  counts: Record<string, number>;
  clients: UsageClientScanResult[];
}

export interface UsageScanOptions {
  since?: string;
  /** When set, replaces default ~/.claude|codex|cursor roots (tests). */
  logRoots?: Partial<UsageLogRoots>;
  now?: number;
}

async function walkJsonlFiles(
  root: string,
  sinceMs: number,
  onFile: (filePath: string, mtimeMs: number, content: string) => void
): Promise<string[]> {
  const scanned: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) {
        continue;
      }
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      let content: string;
      try {
        content = await readFile(full, "utf8");
      } catch {
        continue;
      }
      scanned.push(full);
      onFile(full, st.mtimeMs, content);
    }
  }
  await walk(root);
  return scanned;
}

async function pathExists(dir: string): Promise<boolean> {
  try {
    await stat(dir);
    return true;
  } catch {
    return false;
  }
}

export async function scanToolUsage(opts: UsageScanOptions = {}): Promise<UsageScanResult> {
  const now = opts.now ?? Date.now();
  const sinceDate = parseSinceOption(opts.since, now);
  const sinceMs = sinceDate.getTime();
  const roots = { ...defaultUsageLogRoots(), ...opts.logRoots };
  const counts = new Map<string, number>();
  const clients: UsageClientScanResult[] = [];

  // Claude Code
  {
    const id: UsageClientId = "claude-code";
    if (!(await pathExists(roots.claudeCode))) {
      clients.push({
        id,
        status: "missing",
        message: `No Claude Code log directory at ${roots.claudeCode}.`,
        scannedPaths: [],
      });
    } else {
      try {
        const scanned = await walkJsonlFiles(roots.claudeCode, sinceMs, (_p, mtime, content) => {
          parseClaudeCodeJsonlContent(content, sinceMs, mtime, counts);
        });
        clients.push({
          id,
          status: "ok",
          message:
            scanned.length === 0
              ? "No session transcripts modified within the window."
              : undefined,
          scannedPaths: scanned,
        });
      } catch {
        clients.push({
          id,
          status: "unreadable",
          message: `Could not read Claude Code logs under ${roots.claudeCode}.`,
          scannedPaths: [],
        });
      }
    }
  }

  // Codex
  {
    const id: UsageClientId = "codex";
    const codexRoot = roots.codex;
    if (!(await pathExists(codexRoot))) {
      clients.push({
        id,
        status: "missing",
        message: `No Codex session directory at ${codexRoot}.`,
        scannedPaths: [],
      });
    } else {
      try {
        const scanned = await walkJsonlFiles(codexRoot, sinceMs, (_p, mtime, content) => {
          parseCodexJsonlContent(content, sinceMs, mtime, counts);
        });
        clients.push({
          id,
          status: "ok",
          message:
            scanned.length === 0
              ? "No rollout transcripts modified within the window."
              : undefined,
          scannedPaths: scanned,
        });
      } catch {
        clients.push({
          id,
          status: "unreadable",
          message: `Could not read Codex rollouts under ${codexRoot}.`,
          scannedPaths: [],
        });
      }
    }
  }

  // Cursor
  {
    const id: UsageClientId = "cursor";
    if (!(await pathExists(roots.cursor))) {
      clients.push({
        id,
        status: "missing",
        message: `No Cursor projects directory at ${roots.cursor}.`,
        scannedPaths: [],
      });
    } else {
      try {
        const scanned = await walkJsonlFiles(roots.cursor, sinceMs, (_p, mtime, content) => {
          parseCursorJsonlContent(content, sinceMs, mtime, counts);
        });
        clients.push({
          id,
          status: "ok",
          message:
            scanned.length === 0
              ? "No agent transcripts modified within the window."
              : undefined,
          scannedPaths: scanned,
        });
      } catch {
        clients.push({
          id,
          status: "unreadable",
          message: `Could not read Cursor transcripts under ${roots.cursor}.`,
          scannedPaths: [],
        });
      }
    }
  }

  const countsObj: Record<string, number> = {};
  for (const [k, v] of counts) {
    countsObj[k] = v;
  }

  return {
    sinceIso: sinceDate.toISOString(),
    windowDays: defaultSinceDays(opts.since),
    counts: countsObj,
    clients,
  };
}

export function countForTool(
  counts: Record<string, number>,
  server: string,
  tool: string
): number {
  return counts[usageCountKey(server, tool)] ?? 0;
}
