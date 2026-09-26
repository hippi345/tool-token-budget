import { useState } from "react";
import type { Report } from "./types";

interface LintDrillDownProps {
  report: Report;
}

export function LintDrillDown({ report }: LintDrillDownProps) {
  const [expandedFinding, setExpandedFinding] = useState<number | null>(null);
  const [severityFilter, setSeverityFilter] = useState<"all" | "error" | "warn" | "info">("all");

  const filteredFindings = report.findings.filter((f) => {
    if (severityFilter === "all") return true;
    return f.severity === severityFilter;
  });

  const toggleFinding = (index: number) => {
    setExpandedFinding(expandedFinding === index ? null : index);
  };

  const countBySeverity = {
    error: report.findings.filter((f) => f.severity === "error").length,
    warn: report.findings.filter((f) => f.severity === "warn").length,
    info: report.findings.filter((f) => f.severity === "info").length,
  };

  if (report.findings.length === 0) {
    return (
      <div className="lint-drilldown">
        <h2>Lint Findings</h2>
        <p className="no-findings">✓ No lint findings — schemas are clean!</p>
      </div>
    );
  }

  return (
    <div className="lint-drilldown">
      <header className="lint-header">
        <h2>Lint Findings ({report.findings.length})</h2>
        <div className="severity-filters">
          <button
            className={severityFilter === "all" ? "active" : ""}
            onClick={() => setSeverityFilter("all")}
          >
            All ({report.findings.length})
          </button>
          <button
            className={severityFilter === "error" ? "active error" : "error"}
            onClick={() => setSeverityFilter("error")}
          >
            Error ({countBySeverity.error})
          </button>
          <button
            className={severityFilter === "warn" ? "active warn" : "warn"}
            onClick={() => setSeverityFilter("warn")}
          >
            Warn ({countBySeverity.warn})
          </button>
          <button
            className={severityFilter === "info" ? "active info" : "info"}
            onClick={() => setSeverityFilter("info")}
          >
            Info ({countBySeverity.info})
          </button>
        </div>
      </header>

      <div className="findings-list">
        {filteredFindings.map((finding, index) => {
          const isExpanded = expandedFinding === index;
          const tool = report.tools.find((t) => t.server === finding.server && t.name === finding.tool);

          return (
            <div key={index} className={`finding-item finding-${finding.severity}`}>
              <div className="finding-summary" onClick={() => toggleFinding(index)}>
                <span className={`severity-badge severity-${finding.severity}`}>
                  {finding.severity}
                </span>
                <span className="rule-id">{finding.ruleId}</span>
                <span className="tool-name">{finding.server}::{finding.tool}</span>
                <span className="expand-icon">{isExpanded ? "▼" : "▶"}</span>
              </div>

              <div className="finding-message">{finding.message}</div>

              {isExpanded && (
                <div className="finding-details">
                  {finding.suggestion && (
                    <div className="suggestion">
                      <strong>Suggestion:</strong> {finding.suggestion}
                    </div>
                  )}
                  {tool && (
                    <div className="tool-info">
                      <div className="info-row">
                        <span className="label">Estimated tokens:</span>
                        <span className="value">{tool.estTokens.toLocaleString()}</span>
                      </div>
                      <div className="info-row">
                        <span className="label">Breakdown:</span>
                        <span className="value">
                          Name: {tool.breakdown.name}, Description: {tool.breakdown.description}, Schema: {tool.breakdown.schema}
                        </span>
                      </div>
                      <div className="info-row">
                        <span className="label">Share of server:</span>
                        <span className="value">{(tool.shareOfServer * 100).toFixed(1)}%</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
