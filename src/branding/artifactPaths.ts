import { access } from "node:fs/promises";
import path from "node:path";

export const TOOL_TOKEN_BUDGET_PROPOSED_FILENAME =
  "mcp.json.tool-token-budget-proposed.json";
export const LEGACY_PROPOSED_FILENAME = "mcp.json.schema-budget-proposed.json";

export const TOOL_TOKEN_BUDGET_EXPORT_DIR = "tool-token-budget-export";
export const LEGACY_EXPORT_DIR = "schema-budget-export";

export const TOOL_TOKEN_BUDGET_LOCK_SUFFIX = ".tool-token-budget.lock";
export const LEGACY_LOCK_SUFFIX = ".schema-budget.lock";

export const GUI_THEME_STORAGE_KEY = "tool-token-budget-theme";
export const LEGACY_GUI_THEME_STORAGE_KEY = "schema-budget-theme";

export const SARIF_TOOL_NAME = "tool-token-budget";
export const SARIF_RULE_ID_PREFIX = "tool-token-budget";

export function defaultProposedFilename(): string {
  return TOOL_TOKEN_BUDGET_PROPOSED_FILENAME;
}

export function defaultExportDirForCwd(cwd: string): string {
  return path.join(cwd, TOOL_TOKEN_BUDGET_EXPORT_DIR);
}

export function lockPathForConfig(mcpConfigPath: string): string {
  return `${mcpConfigPath}${TOOL_TOKEN_BUDGET_LOCK_SUFFIX}`;
}

export function legacyLockPathForConfig(mcpConfigPath: string): string {
  return `${mcpConfigPath}${LEGACY_LOCK_SUFFIX}`;
}

/** Resolve proposed path for apply: explicit wins; else new sibling, else legacy if present. */
export async function resolveProposedPathForApply(
  mcpConfigPath: string,
  explicit?: string
): Promise<string> {
  if (explicit) {
    return path.resolve(explicit);
  }
  const dir = path.dirname(path.resolve(mcpConfigPath));
  const primary = path.join(dir, TOOL_TOKEN_BUDGET_PROPOSED_FILENAME);
  try {
    await access(primary);
    return primary;
  } catch {
    // fall through
  }
  const legacy = path.join(dir, LEGACY_PROPOSED_FILENAME);
  try {
    await access(legacy);
    return legacy;
  } catch {
    return primary;
  }
}

export function sarifRuleId(ruleId: string): string {
  return `${SARIF_RULE_ID_PREFIX}/${ruleId}`;
}

export function isUiWatchDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.TOOL_TOKEN_BUDGET_UI_NO_WATCH === "1" ||
    env.SCHEMA_BUDGET_UI_NO_WATCH === "1"
  );
}

export type ThemePreference = "light" | "dark" | "system";

/** Read theme from localStorage-like map; migrates legacy key once. */
export function readThemePreferenceFromStorage(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">
): ThemePreference {
  const saved = storage.getItem(GUI_THEME_STORAGE_KEY);
  if (saved === "light" || saved === "dark" || saved === "system") {
    return saved;
  }
  const legacy = storage.getItem(LEGACY_GUI_THEME_STORAGE_KEY);
  if (legacy === "light" || legacy === "dark" || legacy === "system") {
    storage.setItem(GUI_THEME_STORAGE_KEY, legacy);
    storage.removeItem(LEGACY_GUI_THEME_STORAGE_KEY);
    return legacy;
  }
  return "system";
}
