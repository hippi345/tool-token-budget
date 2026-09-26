import { useCallback, useEffect, useMemo, useState } from "react";
import type { Report, ClientConfig, ServerMetadata } from "./types";
import type { SnapshotEvent } from "./api";
import { fetchReport, fetchClients, subscribeToEvents, postWatchInterval, fetchHealth, fetchModelPresets } from "./api";
import { Dashboard } from "./Dashboard";
import { isSerializedDiffEmpty } from "./snapshotDiff";
import { Editor } from "./Editor";
import { LintDrillDown } from "./LintDrillDown";
import { Settings } from "./Settings";
import {
  buildModelSelectOptions,
  DEFAULT_PRIMARY_MODEL_ID,
  type ModelPresetOption,
} from "./modelPresetOptions";
import {
  persistPrimaryModelId,
  resolvePrimaryModelId,
} from "./primaryModel";
import {
  SESSION_RESTART_MESSAGE,
  isSessionInvalid,
  onSessionInvalid,
} from "./sessionInvalid";
import "./App.css";

type View = "dashboard" | "editor" | "lint";

export function App() {
  const [report, setReport] = useState<Report | null>(null);
  const [changes, setChanges] = useState<SnapshotEvent["diff"][]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [showSettings, setShowSettings] = useState(false);
  const [clients, setClients] = useState<ClientConfig[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string | undefined>(undefined);
  const [serverMetadata, setServerMetadata] = useState<ServerMetadata>({ reportSource: 'config' });
  const [primaryModelId, setPrimaryModelId] = useState(() => {
    const saved = localStorage.getItem("ttb-primary-model");
    return saved?.trim() || DEFAULT_PRIMARY_MODEL_ID;
  });
  const [primaryStorageReady, setPrimaryStorageReady] = useState(false);
  const [extraModelId, setExtraModelId] = useState(() => {
    return localStorage.getItem("ttb-extra-model") ?? "";
  });
  const [compareEnabled, setCompareEnabled] = useState(() => {
    return Boolean(localStorage.getItem("ttb-extra-model"));
  });
  const [countMode, setCountMode] = useState<"offline" | "api" | "auto">("offline");
  const [optionalApis, setOptionalApis] = useState<{
    anthropic?: boolean;
    gemini?: boolean;
  }>({});
  const [sseReconnecting, setSseReconnecting] = useState(false);
  const [sessionRestarted, setSessionRestarted] = useState(false);
  const [modelPresets, setModelPresets] = useState<ModelPresetOption[]>([]);

  const modelSelectOptions = useMemo(
    () => buildModelSelectOptions(modelPresets, primaryModelId, extraModelId),
    [modelPresets, primaryModelId, extraModelId]
  );

  useEffect(() => {
    if (!primaryStorageReady) return;
    persistPrimaryModelId(primaryModelId);
  }, [primaryModelId, primaryStorageReady]);

  const handleInvalidPrimaryModelId = useCallback(() => {
    setPrimaryModelId(DEFAULT_PRIMARY_MODEL_ID);
    persistPrimaryModelId(DEFAULT_PRIMARY_MODEL_ID);
  }, []);

  useEffect(() => {
    localStorage.setItem("ttb-extra-model", extraModelId);
  }, [extraModelId]);

  useEffect(() => {
    const unsubscribeSessionInvalid = onSessionInvalid(() => {
      setSessionRestarted(true);
      setSseReconnecting(false);
    });

    const unsubscribe = subscribeToEvents(
      (event) => {
        setReport(event.snapshot.report);
        if (event.serverMetadata) {
          setServerMetadata(event.serverMetadata);
        }
        if (event.diff && !isSerializedDiffEmpty(event.diff)) {
          setChanges((prev) => [event.diff!, ...prev].slice(0, 10));
        }
      },
      {
        onReconnecting: () => {
          if (!isSessionInvalid()) {
            setSseReconnecting(true);
          }
        },
        onReconnected: () => setSseReconnecting(false),
        onSessionInvalid: () => {
          setSessionRestarted(true);
          setSseReconnecting(false);
        },
      }
    );

    const savedInterval = localStorage.getItem("refreshInterval");
    if (savedInterval) {
      const interval = parseInt(savedInterval);
      if (interval >= 10 && interval <= 3600) {
        postWatchInterval(interval).catch(err => {
          console.error("Failed to apply saved watch interval:", err);
        });
      }
    }

    const applyDefaultClientFromHealth = (
      clientList: ClientConfig[],
      defaultClientId: string | null | undefined
    ) => {
      if (!defaultClientId) {
        return;
      }
      if (clientList.some((c) => c.id === defaultClientId)) {
        setSelectedClientId((prev) => prev ?? defaultClientId);
      }
    };

    fetchClients()
      .then((c) => {
        if (c.length > 0) {
          setClients(c);
        }
        return fetchHealth()
          .then((h) => {
            applyDefaultClientFromHealth(c, h.defaultClientId);
            return h;
          })
          .catch(() => undefined);
      })
      .catch((err) => {
        console.error("Failed to fetch clients:", err);
      });

    fetchModelPresets()
      .then((models) => {
        const presets = models.map((m) => ({
          id: m.id,
          experimental: m.experimental,
        }));
        setModelPresets(presets);
        const saved = localStorage.getItem("ttb-primary-model");
        const resolved = resolvePrimaryModelId(saved, presets);
        setPrimaryModelId(resolved);
        setPrimaryStorageReady(true);
      })
      .catch(() => {
        const saved = localStorage.getItem("ttb-primary-model")?.trim();
        if (saved) {
          setPrimaryModelId(saved);
        }
        setPrimaryStorageReady(true);
      });

    fetchHealth()
      .then((h) => {
        if (h.countMode === "offline" || h.countMode === "api" || h.countMode === "auto") {
          setCountMode(h.countMode);
        }
        if (h.optionalApis) {
          setOptionalApis(h.optionalApis);
        }
      })
      .catch(() => {
        // keep default offline
      });

    fetchReport()
      .then((resp) => {
        setReport(resp.report);
        setServerMetadata(resp.serverMetadata);
      })
      .catch((err) => {
        if (isSessionInvalid()) {
          setSessionRestarted(true);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      });

    const healthPoll = window.setInterval(() => {
      fetchHealth()
        .then((h) => {
          setServerMetadata((prev) => ({
            ...prev,
            configLoadError: h.configLoadError ?? null,
          }));
          if (h.optionalApis) {
            setOptionalApis(h.optionalApis);
          }
          if (h.countMode === "offline" || h.countMode === "api" || h.countMode === "auto") {
            setCountMode(h.countMode);
          }
          if (h.configLoadError) {
            fetchClients()
              .then((c) => {
                if (c.length > 0) {
                  setClients(c);
                }
              })
              .catch(() => {
                // keep last known client list
              });
          }
        })
        .catch(() => {
          // ignore transient health errors
        });
    }, 2000);

    return () => {
      window.clearInterval(healthPoll);
      unsubscribeSessionInvalid();
      unsubscribe();
    };
  }, []);

  if (error) {
    return (
      <div className="error">
        <h1>Error</h1>
        <p>{error}</p>
      </div>
    );
  }

  if (!report && !sessionRestarted) {
    return (
      <div className="loading">
        <h1>Loading...</h1>
      </div>
    );
  }

  if (!report && sessionRestarted) {
    return (
      <div className="app">
        <header className="app-header">
          <h1>Tool Token Budget</h1>
        </header>
        <main className="app-main">
          <div
            className="sse-reconnect-banner sse-session-invalid-banner"
            role="alert"
            data-testid="session-restarted-banner"
          >
            {SESSION_RESTART_MESSAGE}
          </div>
        </main>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="loading">
        <h1>Loading...</h1>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1>Tool Token Budget</h1>
          {clients.length > 0 && (
            <select
              className="client-selector"
              data-testid="client-select"
              aria-label="MCP client"
              value={selectedClientId || ""}
              onChange={(e) => setSelectedClientId(e.target.value || undefined)}
            >
              <option value="" disabled>
                Choose a client…
              </option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.viewOnly && "(view-only)"}
                </option>
              ))}
            </select>
          )}
        </div>

        <nav className="header-nav">
          <button
            className={view === "dashboard" ? "active" : ""}
            onClick={() => setView("dashboard")}
          >
            Dashboard
          </button>
          <button
            className={view === "editor" ? "active" : ""}
            onClick={() => setView("editor")}
          >
            Editor
          </button>
          <button
            className={view === "lint" ? "active" : ""}
            onClick={() => setView("lint")}
          >
            Lint
          </button>
          <button className="settings-button" onClick={() => setShowSettings(true)} title="Settings">
            ⚙️
          </button>
        </nav>
      </header>

      <main className="app-main">
        {sessionRestarted && (
          <div
            className="sse-reconnect-banner sse-session-invalid-banner"
            role="alert"
            data-testid="session-restarted-banner"
          >
            {SESSION_RESTART_MESSAGE}
          </div>
        )}
        {sseReconnecting && !sessionRestarted && (
          <div
            className="sse-reconnect-banner"
            role="status"
            data-testid="sse-reconnecting"
          >
            Reconnecting to live updates…
          </div>
        )}
        {view === "dashboard" && (
          <Dashboard
            report={report}
            changes={changes}
            countMode={countMode}
            optionalApis={optionalApis}
            modelSelectOptions={modelSelectOptions}
            modelPicker={{
              primaryModelId,
              setPrimaryModelId,
              extraModelId,
              setExtraModelId,
              compareEnabled,
              setCompareEnabled,
              onInvalidPrimaryModelId: handleInvalidPrimaryModelId,
            }}
          />
        )}
        {view === "editor" && (
          <Editor 
            report={report} 
            clientId={selectedClientId} 
            selectedClient={clients.find(c => c.id === selectedClientId)}
            serverMetadata={serverMetadata} 
          />
        )}
        {view === "lint" && <LintDrillDown report={report} />}
      </main>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
