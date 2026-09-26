import { useState, useEffect } from "react";
import type { PolicyOptions } from "./types";
import { fetchHealth, postWatchInterval } from "./api";
import { useTheme } from "./theme";
import { parseOptionalPolicyInt } from "./policyNumbers";

interface SettingsProps {
  onClose: () => void;
}

export function Settings({ onClose }: SettingsProps) {
  const { theme, setTheme } = useTheme();
  const [refreshInterval, setRefreshInterval] = useState(30);
  const [serverInterval, setServerInterval] = useState(30);
  const [defaultPolicy, setDefaultPolicy] = useState<PolicyOptions>({ keepPerServer: 2 });

  useEffect(() => {
    // Load from localStorage
    const savedInterval = localStorage.getItem("refreshInterval");
    const savedPolicy = localStorage.getItem("defaultPolicy");

    if (savedPolicy) {
      try {
        setDefaultPolicy(JSON.parse(savedPolicy));
      } catch {
        // Ignore parse errors
      }
    }

    // Set interval: prefer saved value, then apply it to server
    const loadInterval = async () => {
      if (savedInterval) {
        const interval = parseInt(savedInterval);
        setRefreshInterval(interval);
        // Apply saved interval to server on load
        try {
          const result = await postWatchInterval(interval);
          setServerInterval(result.intervalSec);
        } catch (err) {
          console.error("Failed to set watch interval:", err);
          // Fall back to fetching current server interval
          try {
            const health = await fetchHealth();
            setServerInterval(health.watchIntervalSec);
          } catch {
            // Ignore
          }
        }
      } else {
        // No saved value, fetch current server interval
        try {
          const health = await fetchHealth();
          setServerInterval(health.watchIntervalSec);
          setRefreshInterval(health.watchIntervalSec);
        } catch (err) {
          console.error("Failed to fetch server interval:", err);
        }
      }
    };
    
    loadInterval();
  }, []);

  const handleIntervalChange = async (value: number) => {
    if (value < 10) value = 10;
    if (value > 3600) value = 3600;
    setRefreshInterval(value);
    localStorage.setItem("refreshInterval", value.toString());
    
    // Send to server to update polling interval
    try {
      const result = await postWatchInterval(value);
      setServerInterval(result.intervalSec);
    } catch (err) {
      console.error("Failed to update watch interval:", err);
    }
  };

  const handlePolicyChange = (policy: PolicyOptions) => {
    setDefaultPolicy(policy);
    localStorage.setItem("defaultPolicy", JSON.stringify(policy));
  };

  const handleSave = () => {
    onClose();
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <header className="settings-header">
          <h2>Settings</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </header>

        <section className="settings-section">
          <h3>Appearance</h3>
          <div className="control-group">
            <label>Theme:</label>
            <div className="button-group">
              <button
                className={theme === "light" ? "active" : ""}
                onClick={() => setTheme("light")}
              >
                Light
              </button>
              <button
                className={theme === "dark" ? "active" : ""}
                onClick={() => setTheme("dark")}
              >
                Dark
              </button>
              <button
                className={theme === "system" ? "active" : ""}
                onClick={() => setTheme("system")}
              >
                System
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h3>Live Updates</h3>
          <div className="control-group">
            <label>
              Refresh interval (seconds, 10-3600):
              <input
                type="number"
                min="10"
                max="3600"
                value={refreshInterval}
                onChange={(e) => handleIntervalChange(parseInt(e.target.value) || 10)}
              />
            </label>
            <p className="help-text">
              Controls server's live re-discovery polling. Effective: {serverInterval}s.
            </p>
          </div>
        </section>

        <section className="settings-section">
          <h3>Default Policy</h3>
          <div className="control-group">
            <label>
              Keep per server:
              <input
                type="number"
                min="0"
                value={defaultPolicy.keepPerServer ?? ""}
                onChange={(e) =>
                  handlePolicyChange({ ...defaultPolicy, keepPerServer: parseOptionalPolicyInt(e.target.value) })
                }
              />
            </label>
            <label>
              Keep hot (global):
              <input
                type="number"
                min="0"
                value={defaultPolicy.keepHot ?? ""}
                onChange={(e) =>
                  handlePolicyChange({ ...defaultPolicy, keepHot: parseOptionalPolicyInt(e.target.value) })
                }
              />
            </label>
          </div>
        </section>

        <footer className="settings-footer">
          <button className="save-button" onClick={handleSave}>Close</button>
        </footer>
      </div>
    </div>
  );
}
