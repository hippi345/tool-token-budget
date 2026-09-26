import type { Report } from "../types.js";
import { appendAnalyzeHistory, type HistoryRecordContext } from "../history/store.js";
import {
  evaluateBudgetStatus,
  formatBudgetWarnings,
  type BudgetStatus,
} from "../budget/evaluateBudget.js";
import {
  isHistoryEnabledInConfig,
  loadUserConfig,
  UserConfigError,
  type ToolTokenBudgetUserConfig,
} from "../state/userConfig.js";
import type { UserStatePathDeps } from "../state/userStatePaths.js";
import { isHistoryDisabled } from "../history/store.js";

export const EXIT_CONFIG_BUDGET = 3;

export interface PostAnalyzeOptions {
  clientId?: string;
  noHistory?: boolean;
  stateDeps?: UserStatePathDeps;
  historyFilePath?: string;
  userConfigPath?: string;
  preloadedConfig?: ToolTokenBudgetUserConfig;
  skipHistory?: boolean;
  skipBudget?: boolean;
}

export interface PostAnalyzeResult {
  report: Report;
  budgetStatus: BudgetStatus;
  configError?: UserConfigError;
}

export async function runPostAnalyzeHooks(
  report: Report,
  opts: PostAnalyzeOptions = {}
): Promise<PostAnalyzeResult> {
  let userConfig: ToolTokenBudgetUserConfig = opts.preloadedConfig ?? {};
  let configError: UserConfigError | undefined;

  if (!opts.skipBudget && !opts.preloadedConfig) {
    try {
      const deps: UserStatePathDeps = {
        ...opts.stateDeps,
        env: {
          ...(opts.stateDeps?.env ?? process.env),
          ...(opts.userConfigPath
            ? { TOOL_TOKEN_BUDGET_USER_CONFIG: opts.userConfigPath }
            : {}),
        },
      };
      const loaded = await loadUserConfig(deps);
      userConfig = loaded.config;
    } catch (err) {
      if (err instanceof UserConfigError) {
        configError = err;
        return {
          report,
          budgetStatus: { checks: [], anyExceeded: false, anyNearLimit: false },
          configError,
        };
      }
      throw err;
    }
  }

  const budgetStatus = opts.skipBudget
    ? { checks: [], anyExceeded: false, anyNearLimit: false }
    : evaluateBudgetStatus(report, userConfig.budget, opts.clientId);

  const reportWithBudget: Report = {
    ...report,
    budgetStatus: budgetStatus.checks.length > 0 ? budgetStatus : undefined,
  };

  const env = opts.stateDeps?.env ?? process.env;
  const historyOff =
    opts.noHistory === true ||
    opts.skipHistory === true ||
    isHistoryDisabled(env) ||
    !isHistoryEnabledInConfig(userConfig);

  if (!historyOff) {
    const ctx: HistoryRecordContext = { clientId: opts.clientId };
    await appendAnalyzeHistory(report, ctx, {
      deps: opts.stateDeps,
      historyFilePath: opts.historyFilePath,
      maxEntries: userConfig.history?.maxEntries,
    });
  }

  return { report: reportWithBudget, budgetStatus, configError };
}

export function printBudgetWarnings(budgetStatus: BudgetStatus): void {
  for (const line of formatBudgetWarnings(budgetStatus)) {
    console.error(line);
  }
}
