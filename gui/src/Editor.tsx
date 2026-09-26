import { useState, useEffect, useRef } from "react";
import type { Report, PolicyOptions, ToolMeter, ProposalResponse, ApplyPreviewResponse, ServerMetadata, ClientConfig } from "./types";
import { postProposal, postExport, postApplyPreview, postApply } from "./api";
import { parseOptionalPolicyInt } from "./policyNumbers";
import {
  reconcileApplySectionOnConfigHealth,
  shouldShowApplyPreviewError,
  shouldShowExportError,
  isExportBlockedByConfigLoadError,
  shouldShowExportConfigHint,
  exportButtonTitleWhenConfigError,
  EXPORT_CONFIG_ERROR_HINT_ID,
  EXPORT_CONFIG_ERROR_HINT,
} from "./configHealthUi";

interface EditorProps {
  report: Report;
  clientId?: string;
  selectedClient?: ClientConfig;
  serverMetadata: ServerMetadata;
}

export function Editor({ report, clientId, selectedClient, serverMetadata }: EditorProps) {
  // Load default policy from localStorage, fallback to keepPerServer: 2
  const loadDefaultPolicy = (): PolicyOptions => {
    const saved = localStorage.getItem("defaultPolicy");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        // Ignore parse errors
      }
    }
    return { keepPerServer: 2 };
  };
  
  const [policy, setPolicy] = useState<PolicyOptions>(loadDefaultPolicy());
  const [keepSet, setKeepSet] = useState<Set<string>>(new Set());
  const [proposal, setProposal] = useState<ProposalResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Apply state
  const [preview, setPreview] = useState<ApplyPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  
  // Ref for scrolling errors into view
  const applyErrorRef = useRef<HTMLDivElement>(null);

  // Group tools by server
  const byServer = new Map<string, ToolMeter[]>();
  for (const tool of report.tools) {
    if (!byServer.has(tool.server)) {
      byServer.set(tool.server, []);
    }
    byServer.get(tool.server)!.push(tool);
  }

  // Sort servers by token cost (descending)
  const servers = Array.from(byServer.keys()).sort((a, b) => {
    const aTotal = byServer.get(a)!.reduce((sum, t) => sum + t.estTokens, 0);
    const bTotal = byServer.get(b)!.reduce((sum, t) => sum + t.estTokens, 0);
    return bTotal - aTotal;
  });

  const toolKey = (server: string, name: string) => `${server}::${name}`;

  const countProposedServers = (): number => {
    if (!proposal?.proposedConfig || typeof proposal.proposedConfig !== "object") {
      return servers.length;
    }
    const mcpServers = (proposal.proposedConfig as { mcpServers?: Record<string, unknown> })
      .mcpServers;
    if (!mcpServers || typeof mcpServers !== "object") {
      return 0;
    }
    return Object.keys(mcpServers).length;
  };

  const exportRemovesAllServers =
    Boolean(proposal) && servers.length > 0 && countProposedServers() === 0;

  useEffect(() => {
    if (exportRemovesAllServers) {
      setExportResult(null);
    }
  }, [exportRemovesAllServers]);

  useEffect(() => {
    setExportResult(null);
  }, [clientId, policy.keepPerServer, policy.keepHot, policy.disableServersOver]);

  const prevConfigLoadError = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const next = reconcileApplySectionOnConfigHealth(serverMetadata.configLoadError);
    if (next.clearPreview) {
      setPreview(null);
      setConfirmation("");
      setApplyResult(null);
    }
    if (next.clearExportResult) {
      setExportResult(null);
      setExportError(null);
    }
    if (next.clearApplyError) {
      setError(null);
    }
    if (prevConfigLoadError.current && !serverMetadata.configLoadError) {
      setError((prev) =>
        prev && /cannot be read/i.test(prev) ? null : prev
      );
      setPreview(null);
      setConfirmation("");
    }
    prevConfigLoadError.current = serverMetadata.configLoadError;
  }, [serverMetadata.configLoadError]);

  useEffect(() => {
    if (!serverMetadata.configLoadError) {
      setError((prev) =>
        prev && /cannot be read/i.test(prev) ? null : prev
      );
    }
  }, [report.generatedAt, serverMetadata.configLoadError]);

  // Generate proposal whenever policy changes
  useEffect(() => {
    const generate = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await postProposal(policy, clientId);
        setProposal(result);
        // Build keep set from proposal
        const newKeepSet = new Set<string>(result.keepProposal.keepHot);
        setKeepSet(newKeepSet);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    generate();
  }, [policy, clientId]);


  const setPreset = (preset: "default" | "aggressive" | "minimal") => {
    switch (preset) {
      case "default":
        setPolicy({ keepPerServer: 2 });
        break;
      case "aggressive":
        setPolicy({ keepPerServer: 1 });
        break;
      case "minimal":
        setPolicy({ keepPerServer: 3 });
        break;
    }
  };

  const handleExport = async () => {
    if (!clientId) {
      setError("No client selected");
      return;
    }
    if (isExportBlockedByConfigLoadError(serverMetadata.configLoadError)) {
      return;
    }
    if (exportRemovesAllServers) {
      setError("Cannot export: proposal removes all servers");
      return;
    }
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    try {
      const result = await postExport(policy, clientId);
      setExportResult(`Exported ${result.written.length} file(s) to ${result.exportDir}`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const handlePreview = async () => {
    if (!clientId) {
      setError("No client selected");
      return;
    }
    setPreviewing(true);
    setError(null);
    setPreview(null);
    setConfirmation("");
    setApplyResult(null);
    try {
      const result = await postApplyPreview(policy, clientId);
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Scroll error into view
      setTimeout(() => {
        applyErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 0);
    } finally {
      setPreviewing(false);
    }
  };

  const handleApply = async () => {
    if (!clientId || !preview) {
      setError("No preview available");
      return;
    }
    if (confirmation !== "apply") {
      setError("Please type 'apply' to confirm");
      return;
    }
    setApplying(true);
    setError(null);
    setApplyResult(null);
    try {
      const result = await postApply(
        policy,
        clientId,
        preview.currentHash,
        preview.previewToken,
        confirmation
      );
      if (result.noOp) {
        setApplyResult("No changes to apply (config already matches proposal).");
      } else {
        setApplyResult(`Success! Backup created at: ${result.backupPath}`);
      }
      setPreview(null);
      setConfirmation("");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Conflict:") || errMsg.includes("changed since preview")) {
        setError("Config file has changed since preview. Please click Preview again.");
        setPreview(null);
      } else {
        setError(errMsg);
      }
      // Scroll error into view
      setTimeout(() => {
        applyErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 0);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="editor">
      <header className="editor-header">
        <h2>Policy Editor</h2>
        <div className="presets">
          <label>Presets:</label>
          <button onClick={() => setPreset("aggressive")}>Aggressive (keep 1/server)</button>
          <button onClick={() => setPreset("default")}>Default (keep 2/server)</button>
          <button onClick={() => setPreset("minimal")}>Minimal (keep 3/server)</button>
        </div>
      </header>

      <section className="policy-controls">
        <h3>Global Policy</h3>
        <div className="control-group">
          <label>
            Keep per server:
            <input
              type="number"
              min="0"
              value={policy.keepPerServer ?? ""}
              onChange={(e) => setPolicy({ ...policy, keepPerServer: parseOptionalPolicyInt(e.target.value) })}
            />
          </label>
          <label>
            Keep hot (global):
            <input
              type="number"
              min="0"
              value={policy.keepHot ?? ""}
              onChange={(e) => setPolicy({ ...policy, keepHot: parseOptionalPolicyInt(e.target.value) })}
            />
          </label>
          <label>
            Disable servers over (tokens):
            <input
              type="number"
              min="0"
              value={policy.disableServersOver ?? ""}
              onChange={(e) => setPolicy({ ...policy, disableServersOver: parseOptionalPolicyInt(e.target.value) })}
            />
          </label>
        </div>
      </section>

      {loading && <div className="loading-spinner">Generating proposal...</div>}

      {proposal && proposal.hasZeroKeptWarning && proposal.removedServers.length > 0 && (
        <div className="warning-banner">
          <strong>⚠️ WARNING:</strong> The following server(s) would have zero kept tools and will be removed: {proposal.removedServers.join(", ")}
        </div>
      )}

      {servers.length === 0 && (
        <section className="savings-display">
          <p className="info-message" style={{ color: "#666" }}>
            No MCP servers in the current config. Add servers to your config file to see proposal savings.
          </p>
        </section>
      )}

      {proposal && servers.length > 0 && (
        <section className="savings-display">
          <h3>Proposal Savings</h3>
          <div className="savings-summary">
            <div className="savings-item">
              <span className="label">Current:</span>
              <span className="value">{proposal.savings.currentEstTokens.toLocaleString()} tokens</span>
            </div>
            <div className="savings-item">
              <span className="label">Proposed:</span>
              <span className="value">{proposal.savings.proposedEstTokens.toLocaleString()} tokens</span>
            </div>
            <div className="savings-item savings-highlight">
              <span className="label">Saved:</span>
              <span className="value">
                {proposal.savings.savedEstTokens.toLocaleString()} tokens ({proposal.savings.savedPct.toFixed(1)}%)
              </span>
            </div>
          </div>
        </section>
      )}

      <section className="tools-editor">
        <h3>Tools by Server</h3>
        {servers.map((serverName) => {
          const tools = byServer.get(serverName)!;
          const serverTotal = tools.reduce((sum, t) => sum + t.estTokens, 0);
          const keptCount = tools.filter(t => keepSet.has(toolKey(t.server, t.name))).length;
          const isRemoved = proposal && proposal.removedServers.includes(serverName);

          return (
            <div key={serverName} className={`server-group ${isRemoved ? "server-removed" : ""}`}>
              <div className="server-header">
                <h4>{serverName}</h4>
                <span className="server-stats">
                  {keptCount}/{tools.length} tools kept · {serverTotal.toLocaleString()} tokens
                  {isRemoved && <strong className="removed-label"> (REMOVED)</strong>}
                </span>
              </div>
              <div className="tools-list">
                {tools
                  .sort((a, b) => a.estTokens - b.estTokens)
                  .map((tool) => {
                    const key = toolKey(tool.server, tool.name);
                    const isKept = keepSet.has(key);
                    return (
                      <div key={key} className={`tool-item ${isKept ? "kept" : "deferred"}`}>
                        <span className="tool-name">{tool.name}</span>
                        <span className="tool-tokens">{tool.estTokens.toLocaleString()} tokens</span>
                      </div>
                    );
                  })}
              </div>
            </div>
          );
        })}
      </section>

      <section className="export-section">
        <button 
          onClick={handleExport} 
          disabled={
            exporting || 
            !clientId || 
            (selectedClient?.viewOnly ?? false) ||
            exportRemovesAllServers ||
            isExportBlockedByConfigLoadError(serverMetadata.configLoadError)
          }
          title={exportButtonTitleWhenConfigError(serverMetadata.configLoadError)}
          aria-describedby={
            shouldShowExportConfigHint(serverMetadata.configLoadError)
              ? EXPORT_CONFIG_ERROR_HINT_ID
              : undefined
          }
        >
          {exporting ? "Exporting..." : "Export Proposal"}
        </button>
        {shouldShowExportConfigHint(serverMetadata.configLoadError) && (
          <p
            id={EXPORT_CONFIG_ERROR_HINT_ID}
            className="info-message"
            style={{ color: "#666", fontSize: "0.9em", marginTop: "0.5em" }}
          >
            {EXPORT_CONFIG_ERROR_HINT}
          </p>
        )}
        {selectedClient?.viewOnly && (
          <p className="info-message" style={{ color: '#666', fontSize: '0.9em', marginTop: '0.5em' }}>
            Export not available for view-only clients
          </p>
        )}
        {exportRemovesAllServers && (
          <p className="info-message" style={{ color: '#666', fontSize: '0.9em', marginTop: '0.5em' }}>
            Export disabled: proposal removes all servers (zero kept)
          </p>
        )}
        {exportResult && <div className="success-message">{exportResult}</div>}
        {shouldShowExportError(exportError, serverMetadata.configLoadError) && (
          <div className="error-banner" role="alert" style={{ marginTop: "0.5em" }}>
            {exportError}
          </div>
        )}
      </section>

      <section className="apply-section">
        <h3>Apply Changes</h3>
        <button onClick={handlePreview} disabled={previewing || !clientId || serverMetadata.reportSource === 'tools-json' || (selectedClient?.viewOnly ?? false)}>
          {previewing ? "Loading Preview..." : "Preview Apply"}
        </button>
        {serverMetadata.configLoadError && (
          <div className="error-banner" role="alert" style={{ marginTop: '0.5em' }}>
            Config file cannot be read: {serverMetadata.configLoadError}
          </div>
        )}
        {serverMetadata.reportSource === 'tools-json' && (
          <p className="info-message" style={{ color: '#666', fontSize: '0.9em', marginTop: '0.5em' }}>
            Preview and Apply are not available when using --tools-json
          </p>
        )}
        {selectedClient?.viewOnly && (
          <p className="info-message" style={{ color: '#666', fontSize: '0.9em', marginTop: '0.5em' }}>
            Preview and Apply not available for view-only clients
          </p>
        )}
        
        {shouldShowApplyPreviewError(error, serverMetadata.configLoadError) && (
          <div ref={applyErrorRef} className="error-banner" role="alert" style={{ marginTop: '1em' }}>
            {error}
          </div>
        )}
        
        {preview && (
          <div className="apply-preview">
            <h4>Diff Preview:</h4>
            <pre className="diff-view">{preview.diff}</pre>
            
            {preview.diff !== "No changes." && (
              <>
                <div className="confirmation-input">
                  <label>
                    Type "apply" to confirm:
                    <input
                      type="text"
                      value={confirmation}
                      onChange={(e) => setConfirmation(e.target.value)}
                      placeholder="apply"
                    />
                  </label>
                </div>
                
                <button 
                  onClick={handleApply} 
                  disabled={applying || confirmation !== "apply"}
                  className="apply-button"
                >
                  {applying ? "Applying..." : "Apply Changes"}
                </button>
              </>
            )}
            
            {preview.diff === "No changes." && (
              <p className="info-message" style={{ color: '#666', fontSize: '0.9em', marginTop: '0.5em' }}>
                No changes to apply
              </p>
            )}
          </div>
        )}
        
        {applyResult && <div className="success-message">{applyResult}</div>}
      </section>
    </div>
  );
}
