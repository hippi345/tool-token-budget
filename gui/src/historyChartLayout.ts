import type { AnalyzeHistoryEntry } from "./api";

export interface HistoryBudgetConfig {
  total?: number;
  clients?: Record<string, number>;
}

export interface ChartPoint {
  at: string;
  value: number;
  index: number;
}

export interface ChartSeries {
  id: string;
  label: string;
  points: ChartPoint[];
}

export interface BudgetLine {
  id: string;
  label: string;
  value: number;
  /** Budget is below the data-driven Y scale; draw clamped above the axis. */
  belowScale?: boolean;
}

export interface HistoryChartModel {
  sortedEntries: AnalyzeHistoryEntry[];
  series: ChartSeries[];
  budgetLines: BudgetLine[];
  yMin: number;
  yMax: number;
  xLabels: string[];
  entryCount: number;
}

/** Pixels above the X axis when a budget is below the visible Y scale. */
export const BUDGET_BELOW_SCALE_AXIS_OFFSET_PX = 6;

const CLIENT_COLORS = [
  "#81c784",
  "#ffb74d",
  "#e57373",
  "#ba68c8",
  "#4dd0e1",
  "#fff176",
];

function shortTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso.slice(0, 10);
  }
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hr = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mo}/${day} ${hr}:${min}`;
}

export function buildHistoryChartModel(
  entries: AnalyzeHistoryEntry[],
  budget?: HistoryBudgetConfig
): HistoryChartModel {
  const sorted = [...entries].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at)
  );

  const clientIds = new Set<string>();
  for (const e of sorted) {
    for (const id of Object.keys(e.byClient)) {
      clientIds.add(id);
    }
  }

  const totalSeries: ChartSeries = {
    id: "total",
    label: "Total",
    points: sorted.map((e, index) => ({
      at: e.at,
      value: e.totalTokens,
      index,
    })),
  };

  const clientSeries: ChartSeries[] = [...clientIds].sort().map((id) => ({
    id: `client:${id}`,
    label: id,
    points: sorted
      .map((e, index) =>
        e.byClient[id] !== undefined
          ? { at: e.at, value: e.byClient[id], index }
          : null
      )
      .filter((p): p is ChartPoint => p !== null),
  }));

  const series = [totalSeries, ...clientSeries].filter((s) => s.points.length > 0);

  const budgetLines: BudgetLine[] = [];
  if (budget?.total !== undefined) {
    budgetLines.push({
      id: "budget-total",
      label: `Budget total (${budget.total})`,
      value: budget.total,
    });
  }
  if (budget?.clients) {
    for (const [id, limit] of Object.entries(budget.clients)) {
      budgetLines.push({
        id: `budget-client-${id}`,
        label: `Budget ${id} (${limit})`,
        value: limit,
      });
    }
  }

  const dataValues: number[] = [];
  for (const s of series) {
    for (const p of s.points) {
      dataValues.push(p.value);
    }
  }

  let yMin = dataValues.length ? Math.min(...dataValues) : 0;
  let yMax = dataValues.length ? Math.max(...dataValues) : 1;
  if (yMin === yMax) {
    yMin = Math.max(0, yMin - Math.max(1, yMin * 0.1));
    yMax = yMax + Math.max(1, yMax * 0.1);
  } else {
    const pad = (yMax - yMin) * 0.08;
    yMin = Math.max(0, yMin - pad);
    yMax = yMax + pad;
  }

  const scaleMin = yMin;
  const scaleMax = yMax;
  for (const b of budgetLines) {
    if (b.value < scaleMin) {
      b.belowScale = true;
    }
  }
  const padSpan = scaleMax - scaleMin;
  let maxInScaleBudget = scaleMax;
  for (const b of budgetLines) {
    if (!b.belowScale && b.value > maxInScaleBudget) {
      maxInScaleBudget = b.value;
    }
  }
  if (maxInScaleBudget > scaleMax) {
    yMax = maxInScaleBudget + padSpan * 0.08;
  }

  const xLabels = sorted.map((e) => shortTimeLabel(e.at));

  return {
    sortedEntries: sorted,
    series,
    budgetLines,
    yMin,
    yMax,
    xLabels,
    entryCount: sorted.length,
  };
}

export function seriesColor(seriesId: string, clientIndex: number): string {
  if (seriesId === "total") {
    return "var(--color-primary)";
  }
  return CLIENT_COLORS[clientIndex % CLIENT_COLORS.length]!;
}

export function formatTokenTick(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(Math.round(n));
}

export function yToPlot(
  value: number,
  yMin: number,
  yMax: number,
  plotTop: number,
  plotHeight: number
): number {
  const span = yMax - yMin || 1;
  return plotTop + plotHeight - ((value - yMin) / span) * plotHeight;
}

export function xToPlot(
  index: number,
  count: number,
  plotLeft: number,
  plotWidth: number
): number {
  if (count <= 1) {
    return plotLeft + plotWidth / 2;
  }
  return plotLeft + (index / (count - 1)) * plotWidth;
}
