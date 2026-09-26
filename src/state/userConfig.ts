import { readFile } from "node:fs/promises";
import { parseJSON } from "../utils/json.js";
import { getUserConfigFilePath, type UserStatePathDeps } from "./userStatePaths.js";

export interface UserBudgetConfig {
  /** Global total token budget (analyze estimate). */
  total?: number;
  /** Per MCP client config id (--client). */
  clients?: Record<string, number>;
  /** Per model id (--model / tokenCountsByModel keys). */
  models?: Record<string, number>;
}

export interface UserHistoryConfig {
  enabled?: boolean;
  maxEntries?: number;
}

export interface ToolTokenBudgetUserConfig {
  history?: UserHistoryConfig;
  budget?: UserBudgetConfig;
}

export class UserConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserConfigError";
  }
}

function assertPositiveBudget(label: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new UserConfigError(`Invalid budget config: ${label} must be a non-negative number`);
  }
  return value;
}

function parseBudgetSection(raw: unknown): UserBudgetConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new UserConfigError('Invalid budget config: "budget" must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const budget: UserBudgetConfig = {};
  if (obj.total !== undefined) {
    budget.total = assertPositiveBudget("budget.total", obj.total);
  }
  if (obj.clients !== undefined) {
    if (typeof obj.clients !== "object" || obj.clients === null || Array.isArray(obj.clients)) {
      throw new UserConfigError('Invalid budget config: "budget.clients" must be an object');
    }
    budget.clients = {};
    for (const [k, v] of Object.entries(obj.clients as Record<string, unknown>)) {
      budget.clients[k] = assertPositiveBudget(`budget.clients.${k}`, v);
    }
  }
  if (obj.models !== undefined) {
    if (typeof obj.models !== "object" || obj.models === null || Array.isArray(obj.models)) {
      throw new UserConfigError('Invalid budget config: "budget.models" must be an object');
    }
    budget.models = {};
    for (const [k, v] of Object.entries(obj.models as Record<string, unknown>)) {
      budget.models[k] = assertPositiveBudget(`budget.models.${k}`, v);
    }
  }
  if (
    budget.total === undefined &&
    (!budget.clients || Object.keys(budget.clients).length === 0) &&
    (!budget.models || Object.keys(budget.models).length === 0)
  ) {
    throw new UserConfigError(
      "Invalid budget config: set budget.total, budget.clients, and/or budget.models"
    );
  }
  return budget;
}

export function parseUserConfig(raw: unknown): ToolTokenBudgetUserConfig {
  if (raw === null || raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new UserConfigError("Invalid config: root must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const config: ToolTokenBudgetUserConfig = {};

  if (obj.history !== undefined) {
    if (typeof obj.history !== "object" || obj.history === null || Array.isArray(obj.history)) {
      throw new UserConfigError('Invalid config: "history" must be an object');
    }
    const h = obj.history as Record<string, unknown>;
    config.history = {};
    if (h.enabled !== undefined && typeof h.enabled !== "boolean") {
      throw new UserConfigError('Invalid config: "history.enabled" must be a boolean');
    }
    if (h.enabled !== undefined) {
      config.history.enabled = h.enabled;
    }
    if (h.maxEntries !== undefined) {
      const n = h.maxEntries;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 1) {
        throw new UserConfigError('Invalid config: "history.maxEntries" must be a positive number');
      }
      config.history.maxEntries = Math.floor(n);
    }
  }

  if (obj.budget !== undefined) {
    config.budget = parseBudgetSection(obj.budget);
  }

  return config;
}

export async function loadUserConfig(
  deps?: UserStatePathDeps
): Promise<{ config: ToolTokenBudgetUserConfig; path: string; missing: boolean }> {
  const filePath = getUserConfigFilePath(deps);
  try {
    const raw = await readFile(filePath, "utf8");
    return { config: parseUserConfig(parseJSON(raw)), path: filePath, missing: false };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { config: {}, path: filePath, missing: true };
    }
    if (err instanceof UserConfigError) {
      throw err;
    }
    throw new UserConfigError(
      `Cannot read user config (${filePath}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function isHistoryEnabledInConfig(config: ToolTokenBudgetUserConfig): boolean {
  return config.history?.enabled !== false;
}
