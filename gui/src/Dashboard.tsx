import { useMemo, useState } from "react";
import type { Report } from "./types";
import type { SnapshotEvent } from "./api";
import { useModelCounts } from "./useModelCounts";
import type { ModelPresetOption } from "./modelConstants";
import { countModeDisplayLabel } from "./countModeDisplay";
import { HistoryChart } from "./HistoryChart";

export interface DashboardModelPickerState {
  primaryModelId: string;
  setPrimaryModelId: (id: string) => void;
  extraModelId: string;
  setExtraModelId: (id: string) => void;
  compareEnabled: boolean;
  setCompareEnabled: (enabled: boolean) => void;
  onInvalidPrimaryModelId?: () => void;
}

interface DashboardProps {
  report: Report;
  changes: SnapshotEvent["diff"][];
  modelPicker: DashboardModelPickerState;
  modelSelectOptions: ModelPresetOption[];
  countMode: "offline" | "api" | "auto";
  optionalApis?: { anthropic?: boolean; gemini?: boolean };
}

function formatModelOptionLabel(id: string, experimental?: boolean): string {
  if (experimental || id === "cursor-dynamic") {
    return `${id} (experimental)`;
  }
  return id;
}

function sourceBadge(source: string): string {
  if (source === "exact-api") return "api";
  if (source === "exact-offline") return "exact";
  return "estimate";
}

export function Dashboard({
  report,
  changes,
  modelPicker,
  modelSelectOptions,
  countMode,
  optionalApis,
}: DashboardProps) {
  const {
    primaryModelId,
    setPrimaryModelId,
    extraModelId,
    setExtraModelId,
    compareEnabled,
    setCompareEnabled,
    onInvalidPrimaryModelId,
  } = modelPicker;

  const [serverSort, setServerSort] = useState<"name" | "tools" | "tokens" | "lint">("name");
  const [serverSortDir, setServerSortDir] = useState<"asc" | "desc">("asc");
  const modelIds = useMemo(() => {
    const ids = [primaryModelId];
    if (compareEnabled && extraModelId && !ids.includes(extraModelId)) {
      ids.push(extraModelId);
    }
    return ids;
  }, [primaryModelId, extraModelId, compareEnabled]);

  const modelCounts = useModelCounts(modelIds, primaryModelId, countMode, {
    onInvalidPrimaryModelId,
  });

  const toggleSort = (col: typeof serverSort) => {
    if (serverSort === col) {
      setServerSortDir(serverSortDir === "asc" ? "desc" : "asc");
    } else {
      setServerSort(col);
      setServerSortDir("asc");
    }
  };

  const serverData = report.servers.map((server) => {
    const tools = report.tools.filter((t) => t.server === server.name);
    const tokens = tools.reduce((sum, t) => sum + t.estTokens, 0);
    const findings = report.findings.filter((f) => f.server === server.name);
    return { server, toolCount: tools.length, tokens, findingCount: findings.length };
  });

  const sortedServers = [...serverData].sort((a, b) => {
    let cmp = 0;
    switch (serverSort) {
      case "name":
        cmp = a.server.name.localeCompare(b.server.name);
        break;
      case "tools":
        cmp = a.toolCount - b.toolCount;
        break;
      case "tokens":
        cmp = a.tokens - b.tokens;
        break;
      case "lint":
        cmp = a.findingCount - b.findingCount;
        break;
    }
    return serverSortDir === "asc" ? cmp : -cmp;
  });

  const topOffenders = [...report.tools]
    .sort((a, b) => b.estTokens - a.estTokens)
    .slice(0, 10);

  const compareOptions = modelSelectOptions.filter((p) => p.id !== primaryModelId);
  const countModeLabel = countModeDisplayLabel(countMode, {
    primarySummary: modelCounts.tokenCountsByModel[primaryModelId],
    optionalApis,
  });

  return (
    <div className="dashboard">
      <section className="model-picker" style={{ marginBottom: "1rem" }}>
        <label>
          Model (primary):{" "}
          <select
            value={primaryModelId}
            onChange={(e) => setPrimaryModelId(e.target.value)}
            data-testid="model-primary-select"
          >
            {modelSelectOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {formatModelOptionLabel(p.id, p.experimental)}
              </option>
            ))}
          </select>
        </label>
        <label style={{ marginLeft: "1rem" }}>
          Compare:{" "}
          <select
            value={extraModelId}
            onChange={(e) => {
              const v = e.target.value;
              setExtraModelId(v);
              setCompareEnabled(Boolean(v));
            }}
            data-testid="model-extra-select"
          >
            <option value="">Off</option>
            {compareOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {formatModelOptionLabel(p.id, p.experimental)}
              </option>
            ))}
          </select>
        </label>
        <span
          className="count-mode-hint"
          data-testid="count-mode-label"
        >
          count mode: {countModeLabel}
        </span>
        {modelCounts.loading && (
          <span style={{ marginLeft: "1rem" }} className="model-counts-loading">
            Computing model columns…
          </span>
        )}
      </section>

      <HistoryChart />

      <section className="totals">
        {modelCounts.loadError && (
          <div
            className="model-counts-error"
            role="alert"
            data-testid="model-counts-error"
          >
            {modelCounts.loadError}
          </div>
        )}
        <div className="total-card">
          <div className="total-value">{report.totals.estTokens.toLocaleString()}</div>
          <div className="total-label">Total Tokens</div>
        </div>
        {modelIds.map((modelId) => {
          const summary = modelCounts.tokenCountsByModel[modelId];
          if (!summary) return null;
          return (
            <div className="total-card" key={modelId} data-testid={`model-total-${modelId}`}>
              <div className="total-value">{summary.total.toLocaleString()}</div>
              <div className="total-label model-total-label">
                <span className="model-total-name">{modelId}</span>
                <span className={`badge badge-${sourceBadge(summary.source)}`}>
                  {sourceBadge(summary.source)}
                </span>
                {modelId === "cursor-dynamic" && (
                  <span className="badge badge-experimental">experimental</span>
                )}
              </div>
            </div>
          );
        })}
        <div className="total-card">
          <div className="total-value">{report.totals.toolCount}</div>
          <div className="total-label">Tools</div>
        </div>
        <div className="total-card">
          <div className="total-value">{report.totals.serverCount}</div>
          <div className="total-label">Servers</div>
        </div>
        <div className="total-card">
          <div className="total-value">{report.totals.findingCount}</div>
          <div className="total-label">Lint Findings</div>
        </div>
      </section>

      {report.savings && (
        <section className="savings-banner">
          <strong>Default Proposal Savings:</strong>{" "}
          {report.savings.savedEstTokens.toLocaleString()} tokens (
          {report.savings.savedPct.toFixed(1)}%) →{" "}
          {report.savings.proposedEstTokens.toLocaleString()} tokens
        </section>
      )}

      <section className="servers-section">
        <h2>Servers</h2>
        <div className="table-scroll-wrap" data-testid="servers-table-wrap">
        <table className="servers-table">
          <thead>
            <tr>
              <th onClick={() => toggleSort("name")} style={{ cursor: "pointer" }}>
                Name {serverSort === "name" && (serverSortDir === "asc" ? "↑" : "↓")}
              </th>
              <th>Status</th>
              <th onClick={() => toggleSort("tools")} style={{ cursor: "pointer" }}>
                Tools {serverSort === "tools" && (serverSortDir === "asc" ? "↑" : "↓")}
              </th>
              <th onClick={() => toggleSort("tokens")} style={{ cursor: "pointer" }}>
                Tokens {serverSort === "tokens" && (serverSortDir === "asc" ? "↑" : "↓")}
              </th>
              <th onClick={() => toggleSort("lint")} style={{ cursor: "pointer" }}>
                Findings {serverSort === "lint" && (serverSortDir === "asc" ? "↑" : "↓")}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedServers.map(({ server, toolCount, tokens, findingCount }) => (
              <tr key={server.name}>
                <td>{server.name}</td>
                <td>
                  <span className={`status status-${server.status}`}>{server.status}</span>
                  {server.error && <div className="error-text">{server.error}</div>}
                </td>
                <td>{toolCount}</td>
                <td>{tokens.toLocaleString()}</td>
                <td>{findingCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>

      <section className="top-offenders">
        <h2>Top 10 Tools by Token Cost</h2>
        <div className="table-scroll-wrap" data-testid="top-offenders-table-wrap">
        <table className="top-offenders-table">
          <thead>
            <tr>
              <th>Server</th>
              <th>Tool</th>
              <th>Tokens (o200k)</th>
              {modelIds.map((id) => (
                <th key={id}>{id}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {topOffenders.map((tool) => {
              const key = `${tool.server}::${tool.name}`;
              return (
                <tr key={key}>
                  <td>{tool.server}</td>
                  <td>{tool.name}</td>
                  <td>{tool.estTokens.toLocaleString()}</td>
                  {modelIds.map((modelId) => {
                    const val =
                      modelCounts.toolCounts[key]?.[modelId] ??
                      tool.countsByModel?.[modelId];
                    return <td key={modelId}>{val != null ? val.toLocaleString() : "—"}</td>;
                  })}
                </tr>
              );
            })}
            {modelIds.some(
              (id) => (modelCounts.tokenCountsByModel[id]?.framingOverhead ?? 0) > 0
            ) && (
              <tr className="framing-overhead-row" data-testid="framing-overhead-row">
                <td colSpan={2}>framing overhead</td>
                <td>—</td>
                {modelIds.map((modelId) => {
                  const overhead =
                    modelCounts.tokenCountsByModel[modelId]?.framingOverhead ?? 0;
                  return (
                    <td key={modelId}>
                      {overhead > 0 ? overhead.toLocaleString() : "—"}
                    </td>
                  );
                })}
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </section>

      {report.findings.length > 0 && (
        <section className="lint-summary">
          <h2>Lint Summary</h2>
          <div className="findings-list">
            {report.findings.slice(0, 20).map((f, i) => (
              <div key={i} className={`finding finding-${f.severity}`}>
                <div className="finding-header">
                  <span className={`severity severity-${f.severity}`}>{f.severity}</span>
                  <span className="rule-id">{f.ruleId}</span>
                  <span className="tool-name">{f.server}::{f.tool}</span>
                </div>
                <div className="finding-message">{f.message}</div>
                {f.suggestion && <div className="finding-suggestion">→ {f.suggestion}</div>}
              </div>
            ))}
            {report.findings.length > 20 && (
              <p className="findings-more">
                ... and {report.findings.length - 20} more findings
              </p>
            )}
          </div>
        </section>
      )}

      {changes.length > 0 && (
        <section className="change-feed">
          <h2>Live Changes</h2>
          <div className="changes-list">
            {changes.map((diff, i) => {
              if (!diff) return null;
              return (
                <div key={i} className="change-item">
                  {diff.servers.added.length > 0 && (
                    <div>+ Servers: {diff.servers.added.join(", ")}</div>
                  )}
                  {diff.servers.removed.length > 0 && (
                    <div>− Servers: {diff.servers.removed.join(", ")}</div>
                  )}
                  {diff.tools.added.length > 0 && (
                    <div>+ Tools: {diff.tools.added.length} (+{diff.tools.added.reduce((s, t) => s + t.estTokens, 0)} tokens)</div>
                  )}
                  {diff.tools.removed.length > 0 && (
                    <div>− Tools: {diff.tools.removed.length} (−{diff.tools.removed.reduce((s, t) => s + t.estTokens, 0)} tokens)</div>
                  )}
                  {diff.tokens.total !== 0 && (
                    <div>
                      Total: {diff.tokens.total > 0 ? "+" : ""}
                      {diff.tokens.total} tokens
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
