import { homedir, platform } from "node:os";
import path from "node:path";
import { getAppDataDirFor } from "../discover/clientConfigs.js";

export const TOOL_TOKEN_BUDGET_STATE_DIR_ENV = "TOOL_TOKEN_BUDGET_STATE_DIR";
export const TOOL_TOKEN_BUDGET_HISTORY_FILE_ENV = "TOOL_TOKEN_BUDGET_HISTORY_FILE";
export const TOOL_TOKEN_BUDGET_USER_CONFIG_ENV = "TOOL_TOKEN_BUDGET_USER_CONFIG";

export const ANALYZE_HISTORY_FILENAME = "analyze-history.json";
export const USER_CONFIG_FILENAME = "config.json";

export interface UserStatePathDeps {
  homedir?: () => string;
  platform?: () => NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Per-user state directory (history, budgets config).
 * Windows: %APPDATA%/tool-token-budget (APPDATA defaults to %USERPROFILE%/AppData/Roaming).
 * macOS: ~/Library/Application Support/tool-token-budget
 * Linux: $XDG_CONFIG_HOME/tool-token-budget or ~/.config/tool-token-budget
 */
export function getToolTokenBudgetStateDir(deps?: UserStatePathDeps): string {
  const env = deps?.env ?? process.env;
  const override = env[TOOL_TOKEN_BUDGET_STATE_DIR_ENV]?.trim();
  if (override) {
    return path.resolve(override);
  }
  const home = (deps?.homedir ?? homedir)();
  const osName = (deps?.platform ?? platform)();
  const appData = getAppDataDirFor(osName, home, env);
  return path.join(appData, "tool-token-budget");
}

export function getAnalyzeHistoryFilePath(deps?: UserStatePathDeps): string {
  const env = deps?.env ?? process.env;
  const override = env[TOOL_TOKEN_BUDGET_HISTORY_FILE_ENV]?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(getToolTokenBudgetStateDir(deps), ANALYZE_HISTORY_FILENAME);
}

export function getUserConfigFilePath(deps?: UserStatePathDeps): string {
  const env = deps?.env ?? process.env;
  const override = env[TOOL_TOKEN_BUDGET_USER_CONFIG_ENV]?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(getToolTokenBudgetStateDir(deps), USER_CONFIG_FILENAME);
}
