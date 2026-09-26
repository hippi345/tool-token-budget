import type { Report } from "../types.js";
import type { UserBudgetConfig } from "../state/userConfig.js";

export const NEAR_LIMIT_RATIO = 0.9;

export type BudgetCheckKind = "total" | "client" | "model";

export interface BudgetCheckResult {
  kind: BudgetCheckKind;
  id?: string;
  limit: number;
  actual: number;
  exceeded: boolean;
  nearLimit: boolean;
}

export interface BudgetStatus {
  checks: BudgetCheckResult[];
  anyExceeded: boolean;
  anyNearLimit: boolean;
}

function modelTotals(report: Report): Record<string, number> {
  const out: Record<string, number> = {};
  if (report.tokenCountsByModel) {
    for (const [id, summary] of Object.entries(report.tokenCountsByModel)) {
      out[id] = summary.total;
    }
  } else {
    out[report.tokenizerId] = report.totals.estTokens;
  }
  return out;
}

export function evaluateBudgetStatus(
  report: Report,
  budget: UserBudgetConfig | undefined,
  analyzeClientId?: string
): BudgetStatus {
  if (!budget) {
    return { checks: [], anyExceeded: false, anyNearLimit: false };
  }

  const checks: BudgetCheckResult[] = [];

  const pushCheck = (
    kind: BudgetCheckKind,
    limit: number,
    actual: number,
    id?: string
  ): void => {
    const exceeded = actual > limit;
    const nearLimit = !exceeded && actual >= limit * NEAR_LIMIT_RATIO;
    checks.push({ kind, id, limit, actual, exceeded, nearLimit });
  };

  if (budget.total !== undefined) {
    pushCheck("total", budget.total, report.totals.estTokens);
  }

  if (budget.clients) {
    for (const [clientId, limit] of Object.entries(budget.clients)) {
      if (analyzeClientId && analyzeClientId !== clientId) {
        continue;
      }
      const actual =
        analyzeClientId === clientId ? report.totals.estTokens : 0;
      if (!analyzeClientId) {
        continue;
      }
      pushCheck("client", limit, actual, clientId);
    }
  }

  const totalsByModel = modelTotals(report);
  if (budget.models) {
    for (const [modelId, limit] of Object.entries(budget.models)) {
      const actual = totalsByModel[modelId] ?? 0;
      pushCheck("model", limit, actual, modelId);
    }
  }

  return {
    checks,
    anyExceeded: checks.some((c) => c.exceeded),
    anyNearLimit: checks.some((c) => c.nearLimit),
  };
}

export function formatBudgetWarnings(status: BudgetStatus): string[] {
  const lines: string[] = [];
  for (const c of status.checks) {
    if (c.exceeded) {
      const label =
        c.kind === "total"
          ? "total"
          : c.kind === "client"
            ? `client ${c.id}`
            : `model ${c.id}`;
      lines.push(
        `warn: budget exceeded for ${label}: estimate ${c.actual} > ${c.limit} tokens`
      );
    } else if (c.nearLimit) {
      const label =
        c.kind === "total"
          ? "total"
          : c.kind === "client"
            ? `client ${c.id}`
            : `model ${c.id}`;
      lines.push(
        `warn: budget near limit for ${label}: estimate ${c.actual} / ${c.limit} tokens`
      );
    }
  }
  return lines;
}
