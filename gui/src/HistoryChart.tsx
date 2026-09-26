import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { fetchAnalyzeHistory, type AnalyzeHistoryEntry } from "./api";
import {
  BUDGET_BELOW_SCALE_AXIS_OFFSET_PX,
  buildHistoryChartModel,
  formatTokenTick,
  seriesColor,
  xToPlot,
  yToPlot,
  type ChartPoint,
  type ChartSeries,
} from "./historyChartLayout";

const MARGIN = { top: 12, right: 12, bottom: 36, left: 52 };
const VIEW_W = 900;
const VIEW_H = 220;

interface TooltipState {
  x: number;
  y: number;
  at: string;
  lines: Array<{ label: string; value: number; color: string }>;
}

function pointsAtIndex(
  series: ChartSeries[],
  index: number
): Array<{ label: string; value: number; color: string; seriesId: string }> {
  const out: Array<{ label: string; value: number; color: string; seriesId: string }> = [];
  let clientIdx = 0;
  for (const s of series) {
    const pt = s.points.find((p) => p.index === index);
    if (pt) {
      const color =
        s.id === "total"
          ? "var(--color-primary)"
          : seriesColor(s.id, clientIdx);
      if (s.id !== "total") {
        clientIdx += 1;
      }
      out.push({ label: s.label, value: pt.value, color, seriesId: s.id });
    }
  }
  return out;
}

function polylineForSeries(
  s: ChartSeries,
  entryCount: number,
  yMin: number,
  yMax: number,
  plotLeft: number,
  plotTop: number,
  plotWidth: number,
  plotHeight: number
): string {
  if (s.points.length === 0) {
    return "";
  }
  return s.points
    .map((p) => {
      const x = xToPlot(p.index, entryCount, plotLeft, plotWidth);
      const y = yToPlot(p.value, yMin, yMax, plotTop, plotHeight);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function HistoryChart() {
  const [entries, setEntries] = useState<AnalyzeHistoryEntry[]>([]);
  const [budget, setBudget] = useState<{ total?: number; clients?: Record<string, number> }>();
  const [error, setError] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  useEffect(() => {
    fetchAnalyzeHistory()
      .then((data) => {
        setEntries(data.entries);
        setBudget(data.budget);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const model = useMemo(
    () => buildHistoryChartModel(entries, budget),
    [entries, budget]
  );

  const plotLeft = MARGIN.left;
  const plotTop = MARGIN.top;
  const plotWidth = VIEW_W - MARGIN.left - MARGIN.right;
  const plotHeight = VIEW_H - MARGIN.top - MARGIN.bottom;

  const yTicks = useMemo(() => {
    const ticks: number[] = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      ticks.push(model.yMin + ((model.yMax - model.yMin) * i) / steps);
    }
    return ticks;
  }, [model.yMin, model.yMax]);

  const handlePlotHover = (event: MouseEvent<SVGRectElement>) => {
    if (model.entryCount === 0) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const relX = ((event.clientX - rect.left) / rect.width) * plotWidth + plotLeft;
    const idx =
      model.entryCount <= 1
        ? 0
        : Math.round(
            ((relX - plotLeft) / plotWidth) * (model.entryCount - 1)
          );
    const clamped = Math.max(0, Math.min(model.entryCount - 1, idx));
    const at = model.sortedEntries[clamped]?.at ?? "";
    const lines = pointsAtIndex(model.series, clamped);
    if (lines.length === 0) {
      setTooltip(null);
      return;
    }
    setTooltip({
      x: xToPlot(clamped, model.entryCount, plotLeft, plotWidth),
      y: plotTop,
      at,
      lines: lines.map((l) => ({ label: l.label, value: l.value, color: l.color })),
    });
  };

  const legendItems = model.series.map((s, i) => ({
    s,
    color: s.id === "total" ? "var(--color-primary)" : seriesColor(s.id, i - 1),
  }));

  return (
    <section className="history-chart-panel" data-testid="history-chart">
      <h2>Analyze history</h2>
      {error && <p className="history-chart-error">{error}</p>}
      {!error && model.entryCount === 0 && (
        <p className="history-chart-empty" data-testid="history-chart-empty">
          No analyze history recorded yet.
        </p>
      )}
      {!error && model.entryCount > 0 && (
        <div className="history-chart-body">
          {model.series.length > 0 && (
            <ul className="history-chart-legend" data-testid="history-chart-legend">
              {legendItems.map(({ s, color }) => (
                  <li key={s.id} data-series={s.id.replace("client:", "")}>
                    <span className="legend-swatch" style={{ background: color }} />
                    {s.label}
                  </li>
                ))}
              {model.budgetLines.map((b) => (
                <li key={b.id} className="legend-budget" data-budget-line={b.id}>
                  <span className="legend-swatch legend-swatch-budget" />
                  {b.label}
                </li>
              ))}
            </ul>
          )}
          <div className="history-chart-svg-wrap">
            <svg
              className="history-chart-svg"
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="Token estimates over recent analyze runs"
            >
              <g className="history-chart-plot" data-testid="history-chart-plot">
                {yTicks.map((tick) => {
                  const y = yToPlot(tick, model.yMin, model.yMax, plotTop, plotHeight);
                  return (
                    <g key={tick}>
                      <line
                        x1={plotLeft}
                        y1={y}
                        x2={plotLeft + plotWidth}
                        y2={y}
                        className="history-grid-line"
                      />
                      <text
                        x={plotLeft - 6}
                        y={y + 4}
                        textAnchor="end"
                        className="history-axis-label"
                        data-testid="history-chart-axis-y"
                      >
                        {formatTokenTick(tick)}
                      </text>
                    </g>
                  );
                })}
                {model.xLabels.map((label, i) => {
                  const x = xToPlot(i, model.entryCount, plotLeft, plotWidth);
                  const show =
                    model.entryCount <= 6 ||
                    i === 0 ||
                    i === model.entryCount - 1 ||
                    i % Math.ceil(model.entryCount / 5) === 0;
                  if (!show) {
                    return null;
                  }
                  return (
                    <text
                      key={`${label}-${i}`}
                      x={x}
                      y={plotTop + plotHeight + 22}
                      textAnchor="middle"
                      className="history-axis-label history-axis-x"
                      data-testid="history-chart-axis-x"
                    >
                      {label}
                    </text>
                  );
                })}
                <line
                  x1={plotLeft}
                  y1={plotTop}
                  x2={plotLeft}
                  y2={plotTop + plotHeight}
                  className="history-axis-line"
                />
                <line
                  x1={plotLeft}
                  y1={plotTop + plotHeight}
                  x2={plotLeft + plotWidth}
                  y2={plotTop + plotHeight}
                  className="history-axis-line"
                />
                {model.budgetLines.map((b) => {
                  const y = b.belowScale
                    ? plotTop + plotHeight - BUDGET_BELOW_SCALE_AXIS_OFFSET_PX
                    : yToPlot(b.value, model.yMin, model.yMax, plotTop, plotHeight);
                  return (
                    <g key={b.id} data-budget-id={b.id}>
                      <line
                        x1={plotLeft}
                        y1={y}
                        x2={plotLeft + plotWidth}
                        y2={y}
                        className="history-budget-line"
                        data-testid="history-budget-line"
                        strokeDasharray="6 4"
                      />
                      {b.belowScale && (
                        <text
                          x={plotLeft + 4}
                          y={y - 4}
                          className="history-budget-below-label"
                          data-testid="history-budget-below-scale-label"
                        >
                          budget {b.value.toLocaleString()} (below scale)
                        </text>
                      )}
                    </g>
                  );
                })}
                {legendItems.map(({ s, color }) => {
                  const pts = polylineForSeries(
                    s,
                    model.entryCount,
                    model.yMin,
                    model.yMax,
                    plotLeft,
                    plotTop,
                    plotWidth,
                    plotHeight
                  );
                  return (
                    <g key={s.id} data-testid="history-chart-series">
                      <polyline
                        points={pts}
                        fill="none"
                        className="history-chart-series-line"
                        stroke={color}
                        data-series={s.id.replace("client:", "")}
                      />
                      {s.points.map((p: ChartPoint) => {
                        const cx = xToPlot(p.index, model.entryCount, plotLeft, plotWidth);
                        const cy = yToPlot(
                          p.value,
                          model.yMin,
                          model.yMax,
                          plotTop,
                          plotHeight
                        );
                        return (
                          <circle
                            key={`${s.id}-${p.index}`}
                            cx={cx}
                            cy={cy}
                            r={model.entryCount === 1 ? 5 : 3.5}
                            className="history-chart-point"
                            fill={color}
                          />
                        );
                      })}
                    </g>
                  );
                })}
                <rect
                  x={plotLeft}
                  y={plotTop}
                  width={plotWidth}
                  height={plotHeight}
                  fill="transparent"
                  className="history-chart-hover-layer"
                  onMouseMove={handlePlotHover}
                  onMouseLeave={() => setTooltip(null)}
                />
                {tooltip && (
                  <g className="history-chart-tooltip" data-testid="history-chart-tooltip">
                    <rect
                      x={Math.min(tooltip.x + 8, plotLeft + plotWidth - 120)}
                      y={plotTop + 4}
                      width={118}
                      height={14 + tooltip.lines.length * 14}
                      rx={4}
                      className="history-tooltip-box"
                    />
                    <text
                      x={Math.min(tooltip.x + 14, plotLeft + plotWidth - 114)}
                      y={plotTop + 16}
                      className="history-tooltip-title"
                    >
                      {tooltip.at.slice(0, 19).replace("T", " ")}
                    </text>
                    {tooltip.lines.map((line, i) => (
                      <text
                        key={line.label}
                        x={Math.min(tooltip.x + 14, plotLeft + plotWidth - 114)}
                        y={plotTop + 30 + i * 14}
                        className="history-tooltip-line"
                        fill={line.color}
                      >
                        {line.label}: {line.value.toLocaleString()}
                      </text>
                    ))}
                  </g>
                )}
              </g>
            </svg>
          </div>
          <div className="history-chart-meta">
            <span className="history-count">n={model.entryCount} runs</span>
          </div>
        </div>
      )}
    </section>
  );
}
