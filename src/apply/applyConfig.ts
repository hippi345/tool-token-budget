import { readFile, writeFile, open, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { makeUniqueTimestamp } from "../utils/timestamp.js";
import { parseJSON } from "../utils/json.js";
import {
  computeConfigContentHash,
  findUnexpectedServerRemovals,
} from "../mcp/configGuards.js";
import { withApplyFileLock, ApplyLockError } from "./applyLock.js";
import type { Report } from "../types.js";
import { formatConfigLoadError } from "../config/formatConfigLoadError.js";
import { configsSemanticallyEqual } from "../utils/configFormat.js";
import {
  getConfigSurface,
  getServerNamesFromClientConfig,
  parseClientConfigContent,
} from "../config/configSurfaces.js";
import { renameWithRetry } from "../utils/renameWithRetry.js";

/**
 * Extract the original value from a string that matches a pattern in the redacted string.
 * Used to restore secrets embedded in strings like --flag=<from-original> or ?param=<from-original>.
 */
function extractOriginalValue(
  redactedStr: string,
  originalStr: string,
  pattern: RegExp,
  placeholder: string
): string | null {
  const redactedMatch = redactedStr.match(pattern);
  const originalMatch = originalStr.match(pattern);
  
  if (!redactedMatch || !originalMatch) {
    return null;
  }
  
  // Check if the redacted version has the placeholder
  if (redactedMatch[0].includes(placeholder)) {
    return originalMatch[0];
  }
  
  return null;
}

/**
 * Restore secrets in a string that has embedded placeholders.
 * Handles --flag=<from-original>, ?param=<from-original>, and https://<from-original>@host patterns.
 */
function restoreStringSecrets(
  proposedStr: string,
  originalStr: string,
  placeholder: string = "<from-original>"
): { result: string; errors: string[] } {
  const errors: string[] = [];
  let result = proposedStr;
  
  // If the entire string is a placeholder, return original
  if (result === placeholder) {
    if (originalStr !== undefined && typeof originalStr === "string") {
      return { result: originalStr, errors };
    }
    errors.push(`Cannot resolve ${placeholder}: original is not a string`);
    return { result, errors };
  }
  
  // Restore --flag=<from-original> and -flag=<from-original> patterns (more general)
  const flagPattern = /(-+)([a-zA-Z][-_a-zA-Z0-9]*)=([^\s]+)/g;
  let match;
  const flagMatches = [];
  while ((match = flagPattern.exec(result)) !== null) {
    if (match[3] === placeholder) {
      flagMatches.push({ dashes: match[1], name: match[2], full: match[0] });
    }
  }
  
  for (const matchInfo of flagMatches) {
    // Find the same flag in the original string
    const flagRegex = new RegExp(`${matchInfo.dashes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${matchInfo.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^\\s]+)`, 'i');
    const originalMatch = originalStr.match(flagRegex);
    if (originalMatch && originalMatch[1] !== placeholder) {
      // Replace the placeholder with the original value
      result = result.replace(
        new RegExp(`${matchInfo.dashes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${matchInfo.name}=${placeholder}`, 'i'),
        `${matchInfo.dashes}${matchInfo.name}=${originalMatch[1]}`
      );
    } else {
      errors.push(`Cannot restore ${matchInfo.dashes}${matchInfo.name}=${placeholder}: original value not found`);
    }
  }
  
  // Restore URL userinfo and query params (string-only — never new URL().toString())
  const encodedPlaceholder = encodeURIComponent(placeholder);
  if (result.includes(placeholder) || result.includes(encodedPlaceholder)) {
    if (result.includes(`://${placeholder}@`) || result.includes(`://${encodedPlaceholder}@`)) {
      const userinfoPattern = /([a-z][a-z0-9+.-]*:\/\/)([^@/]+)@/i;
      const originalMatch = originalStr.match(userinfoPattern);
      if (originalMatch && originalMatch[2]) {
        result = result.replace(
          new RegExp(`://${placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@`, "g"),
          `://${originalMatch[2]}@`
        );
        result = result.replace(
          new RegExp(`://${encodedPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@`, "g"),
          `://${originalMatch[2]}@`
        );
      } else {
        errors.push(`Cannot restore URL userinfo ${placeholder}: original value not found`);
      }
    }

    const queryParamPattern = /([?&])([a-zA-Z_][-_a-zA-Z0-9]*)=([^&\s#]+)/g;
    let qMatch;
    const queryMatches: { sep: string; name: string }[] = [];
    while ((qMatch = queryParamPattern.exec(result)) !== null) {
      if (qMatch[3] === placeholder || qMatch[3] === encodedPlaceholder) {
        queryMatches.push({ sep: qMatch[1], name: qMatch[2] });
      }
    }

    for (const qInfo of queryMatches) {
      const qRegex = new RegExp(
        `[?&]${qInfo.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^&\\s#]+)`
      );
      const origMatch = originalStr.match(qRegex);
      if (origMatch && origMatch[1] !== placeholder && origMatch[1] !== encodedPlaceholder) {
        result = result.replace(
          new RegExp(`([?&])${qInfo.name}=${placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
          `$1${qInfo.name}=${origMatch[1]}`
        );
        result = result.replace(
          new RegExp(
            `([?&])${qInfo.name}=${encodedPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
          ),
          `$1${qInfo.name}=${origMatch[1]}`
        );
      } else {
        errors.push(
          `Cannot restore query param ${qInfo.name}=${placeholder}: original value not found`
        );
      }
    }

    const stillHasPlaceholder =
      result.includes(placeholder) || result.includes(encodedPlaceholder);
    if (
      !stillHasPlaceholder &&
      typeof originalStr === "string" &&
      /^[a-z][a-z0-9+.-]*:\/\//i.test(originalStr)
    ) {
      result = originalStr;
    }
  }
  
  // Restore URL query params: ?param=<from-original>
  const queryPattern = /([?&])(token|api[-_]?key|apikey|key|access[-_]?token|auth|sig|secret|password|credential|session|bearer)=([^&\s#]*)/gi;
  const queryMatches = [];
  while ((match = queryPattern.exec(result)) !== null) {
    if (match[3] === placeholder) {
      queryMatches.push({ separator: match[1], param: match[2], index: match.index });
    }
  }
  
  for (const matchInfo of queryMatches) {
    const param = matchInfo.param;
    // Escape special regex chars in param name
    const escapedParam = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const paramRegex = new RegExp(`([?&])(${escapedParam})=([^&\\s#]*)`, 'i');
    const originalMatch = originalStr.match(paramRegex);
    if (originalMatch && originalMatch[3] && originalMatch[3] !== placeholder) {
      // Replace the placeholder with the original value
      const searchRegex = new RegExp(`([?&])(${escapedParam})=${placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      result = result.replace(searchRegex, `$1$2=${originalMatch[3]}`);
    } else {
      errors.push(`Cannot restore query param ${param}=${placeholder}: original value not found`);
    }
  }
  
  return { result, errors };
}

export interface ApplyOptions {
  mcpConfigPath: string;
  proposedPath: string;
  dryRun: boolean;
  backup: boolean;
  yes: boolean;
  /** When set, refuse apply if live config hash differs (from preview/emit). */
  expectedSourceHash?: string;
}

export interface ApplyResult {
  success: boolean;
  noOp?: boolean;
  backupPath?: string;
  error?: string;
  diffSummary?: {
    serversRemoved: string[];
    serversKept: string[];
    totalBefore: number;
    totalAfter: number;
  };
}

/**
 * Restore secret values from original config by replacing <from-original> sentinels.
 * Works recursively at ANY path to rehydrate ALL placeholders.
 */
export function restoreSecrets(
  proposed: unknown,
  original: unknown,
  path: string[] = []
): { result: unknown; errors: string[] } {
  const errors: string[] = [];

  // Handle primitives
  if (!proposed || typeof proposed !== "object") {
    // If the proposed value is the placeholder, restore from original
    if (proposed === "<from-original>") {
      if (original === undefined) {
        errors.push(`Cannot resolve <from-original> at ${path.join(".")}: no value in original config`);
        // Return the placeholder - caller should reject the apply
        return { result: proposed, errors };
      }
      return { result: original, errors };
    }
    
    // Handle strings with embedded placeholders
    if (typeof proposed === "string" && proposed.includes("<from-original>")) {
      const originalStr = typeof original === "string" ? original : "";
      const { result, errors: strErrors } = restoreStringSecrets(proposed, originalStr);
      errors.push(...strErrors);
      return { result, errors };
    }
    
    return { result: proposed, errors };
  }

  // Handle arrays
  if (Array.isArray(proposed)) {
    const restored = [];
    for (let i = 0; i < proposed.length; i++) {
      const { result, errors: subErrors } = restoreSecrets(
        proposed[i],
        Array.isArray(original) ? original[i] : undefined,
        [...path, `[${i}]`]
      );
      restored.push(result);
      errors.push(...subErrors);
    }
    return { result: restored, errors };
  }

  // Handle objects recursively
  const result: Record<string, unknown> = {};
  const proposedObj = proposed as Record<string, unknown>;
  const originalObj = (original && typeof original === "object" && !Array.isArray(original))
    ? original as Record<string, unknown>
    : {};

  for (const [key, value] of Object.entries(proposedObj)) {
    const currentPath = [...path, key];
    
    // Check if this value itself is the placeholder
    if (value === "<from-original>") {
      if (key in originalObj) {
        result[key] = originalObj[key];
      } else {
        errors.push(`Cannot resolve <from-original> at ${currentPath.join(".")}: key not found in original config`);
        result[key] = value; // Keep placeholder - caller should reject
      }
    } else if (typeof value === "string" && value.includes("<from-original>")) {
      // Handle strings with embedded placeholders
      const originalStr = typeof originalObj[key] === "string" ? originalObj[key] : "";
      const { result: restoredStr, errors: strErrors } = restoreStringSecrets(value, originalStr);
      result[key] = restoredStr;
      errors.push(...strErrors.map(e => `${currentPath.join(".")}: ${e}`));
    } else if (value && typeof value === "object") {
      // Recurse into nested objects/arrays
      const { result: restoredValue, errors: subErrors } = restoreSecrets(
        value,
        originalObj[key],
        currentPath
      );
      result[key] = restoredValue;
      errors.push(...subErrors);
    } else {
      result[key] = value;
    }
  }

  return { result, errors };
}

/**
 * Apply a proposed MCP config to the live mcp.json.
 * Safety: requires both --backup and --yes to actually write.
 */
type AdjacentReportLoad =
  | { ok: true; report: Report }
  | { ok: false; error: string };

async function loadEmitReportAdjacentToProposed(
  proposedPath: string
): Promise<AdjacentReportLoad> {
  const reportPath = path.join(path.dirname(proposedPath), "report.json");
  if (!existsSync(reportPath)) {
    return {
      ok: false,
      error:
        "Adjacent report.json is missing next to the proposed config. Re-run tool-token-budget emit before apply.",
    };
  }
  try {
    const report = parseJSON(await readFile(reportPath, "utf8")) as Report;
    return { ok: true, report };
  } catch {
    return {
      ok: false,
      error:
        "Adjacent report.json is corrupt or unreadable. Re-run tool-token-budget emit before apply.",
    };
  }
}

export async function applyConfig(opts: ApplyOptions): Promise<ApplyResult> {
  // Check if proposed file exists
  if (!existsSync(opts.proposedPath)) {
    return {
      success: false,
      error: `Proposed config not found: ${opts.proposedPath}`,
    };
  }

  // Read both configs
  let originalConfig: unknown;
  let proposedConfig: unknown;

  let originalContent = "";
  try {
    originalContent = await readFile(opts.mcpConfigPath, "utf8");
    originalConfig = parseClientConfigContent(originalContent, opts.mcpConfigPath);
  } catch (err) {
    return {
      success: false,
      error: `Failed to read original config: ${formatConfigLoadError(err)}`,
    };
  }

  try {
    proposedConfig = parseJSON(await readFile(opts.proposedPath, "utf8"));
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse proposed config: ${formatConfigLoadError(err)}`,
    };
  }

  const reportLoad = await loadEmitReportAdjacentToProposed(opts.proposedPath);
  if (!reportLoad.ok) {
    return { success: false, error: reportLoad.error };
  }
  const emitReport = reportLoad.report;
  const expectedRemovals = new Set(emitReport.savings?.removedServers ?? []);
  const expectedSourceHash = opts.expectedSourceHash ?? emitReport.sourceConfigHash;

  if (!expectedSourceHash) {
    return {
      success: false,
      error:
        "Adjacent report.json has no sourceConfigHash. Re-run tool-token-budget emit before apply.",
    };
  }

  const currentHash = computeConfigContentHash(await readFile(opts.mcpConfigPath, "utf8"));
  if (currentHash !== expectedSourceHash) {
    return {
      success: false,
      error:
        "Config changed since emit/preview; re-run emit and apply (hash mismatch).",
    };
  }

  // Restore secrets from original config
  const { result: restoredConfig, errors } = restoreSecrets(proposedConfig, originalConfig);
  if (errors.length > 0) {
    return {
      success: false,
      error: `Failed to restore secrets: ${errors.join("; ")}`,
    };
  }

  const unexpectedRemovals = findUnexpectedServerRemovals(
    originalConfig,
    restoredConfig,
    expectedRemovals,
    { report: emitReport, configPath: opts.mcpConfigPath }
  );
  if (unexpectedRemovals.length > 0) {
    return {
      success: false,
      error: `would unexpectedly remove servers: ${unexpectedRemovals.join(", ")}`,
    };
  }

  // Calculate diff summary
  const diffSummary = calculateDiffSummary(
    originalConfig,
    restoredConfig,
    opts.mcpConfigPath
  );

  // Dry run mode: just show summary
  if (opts.dryRun) {
    return {
      success: true,
      diffSummary,
    };
  }

  // Live replace requires both backup and yes
  if (!opts.backup || !opts.yes) {
    return {
      success: false,
      error: "Live replace requires both --backup and --yes flags",
    };
  }

  try {
    return await withApplyFileLock(opts.mcpConfigPath, async () => {
      const originalContent = await readFile(opts.mcpConfigPath, "utf8");
      if (expectedSourceHash) {
        const currentHash = computeConfigContentHash(originalContent);
        if (currentHash !== expectedSourceHash) {
          return {
            success: false,
            error:
              "Config changed since emit/preview; re-run emit and apply (hash mismatch).",
          };
        }
      }

      const currentParsed = parseClientConfigContent(originalContent, opts.mcpConfigPath);
      if (configsSemanticallyEqual(restoredConfig, currentParsed)) {
        return {
          success: true,
          noOp: true,
          diffSummary,
        };
      }

      // Create backup with exclusive flag (retry on collision)
      let backupPath = `${opts.mcpConfigPath}.bak-${makeUniqueTimestamp()}`;
      let backupRetries = 0;
      const maxBackupRetries = 10;

      while (backupRetries < maxBackupRetries) {
        try {
          const backupFd = await open(backupPath, "wx");
          await backupFd.writeFile(originalContent, "utf8");
          await backupFd.close();
          break;
        } catch (err: unknown) {
          const code =
            err && typeof err === "object" && "code" in err
              ? (err as { code: string }).code
              : "";
          if (code === "EEXIST" && backupRetries < maxBackupRetries - 1) {
            backupPath = `${opts.mcpConfigPath}.bak-${makeUniqueTimestamp()}`;
            backupRetries++;
            continue;
          }
          return {
            success: false,
            error: `Failed to create backup: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      const surface = getConfigSurface(opts.mcpConfigPath, currentParsed);
      const serialized = surface.serializeMerged(originalContent, restoredConfig);
      const tempPath = `${opts.mcpConfigPath}.tmp-${makeUniqueTimestamp()}`;
      try {
        await writeFile(tempPath, serialized, "utf8");
        await renameWithRetry(tempPath, opts.mcpConfigPath);
      } catch (err) {
        await unlink(tempPath).catch(() => {});
        return {
          success: false,
          error: `Failed to write config: ${err instanceof Error ? err.message : String(err)}`,
          backupPath,
        };
      }

      return {
        success: true,
        backupPath,
        diffSummary,
      };
    });
  } catch (err) {
    if (err instanceof ApplyLockError) {
      return { success: false, error: err.message };
    }
    throw err;
  }
}

function calculateDiffSummary(
  original: unknown,
  proposed: unknown,
  configPath?: string
): {
  serversRemoved: string[];
  serversKept: string[];
  totalBefore: number;
  totalAfter: number;
} {
  const serversRemoved: string[] = [];
  const serversKept: string[] = [];

  const origServers = configPath
    ? Object.fromEntries(
        [...getServerNamesFromClientConfig(original, configPath)].map((n) => [n, true])
      )
    : ((original as Record<string, unknown>)?.mcpServers || {}) as Record<string, unknown>;
  const propServers = configPath
    ? Object.fromEntries(
        [...getServerNamesFromClientConfig(proposed, configPath)].map((n) => [n, true])
      )
    : ((proposed as Record<string, unknown>)?.mcpServers || {}) as Record<string, unknown>;

  const totalBefore = Object.keys(origServers).length;
  const totalAfter = Object.keys(propServers).length;

  for (const serverName of Object.keys(origServers)) {
    if (propServers[serverName]) {
      serversKept.push(serverName);
    } else {
      serversRemoved.push(serverName);
    }
  }

  return {
    serversRemoved,
    serversKept,
    totalBefore,
    totalAfter,
  };
}
