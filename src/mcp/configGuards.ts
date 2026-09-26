import { createHash } from "node:crypto";
import { parseMcpConfig } from "../discover/fromMcpConfig.js";
import {
  getConfigSurface,
  getServerNamesFromClientConfig,
} from "../config/configSurfaces.js";
import type { Report, ServerStatus, ToolMeter } from "../types.js";

const DISCOVERY_FAILURE_STATUSES = new Set<ServerStatus>([
  "timed_out",
  "spawn_failed",
  "handshake_failed",
  "tools_list_failed",
]);

export function isDiscoveryFailureStatus(status: ServerStatus): boolean {
  return DISCOVERY_FAILURE_STATUSES.has(status);
}

function serverStatusFromReport(
  report: Report | undefined,
  serverName: string
): ServerStatus | undefined {
  return report?.servers?.find((s) => s.name === serverName)?.status;
}

export function getServerNamesFromConfig(
  config: unknown,
  configPath?: string
): Set<string> {
  if (configPath) {
    return getServerNamesFromClientConfig(config, configPath);
  }
  const names = new Set<string>();
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const configObj = config as Record<string, unknown>;
    const mcpServers = configObj.mcpServers;
    if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
      for (const name of Object.keys(mcpServers as Record<string, unknown>)) {
        names.add(name);
      }
    }
    const servers = configObj.servers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      for (const name of Object.keys(servers as Record<string, unknown>)) {
        names.add(name);
      }
    }
  }
  return names;
}

export function getRemoteServerNames(config: unknown, configPath?: string): Set<string> {
  try {
    const logical =
      configPath && config && typeof config === "object"
        ? { mcpServers: getConfigSurface(configPath, config).extractMcpServers(config) }
        : config;
    return new Set(
      parseMcpConfig(logical)
        .filter((s) => s.kind === "remote")
        .map((s) => s.name)
    );
  } catch {
    return new Set();
  }
}

export function findUnexpectedServerRemovals(
  originalConfig: unknown,
  proposedConfig: unknown,
  expectedRemovals: Set<string>,
  opts?: { report?: Report; configPath?: string }
): string[] {
  const targetServers = getServerNamesFromConfig(originalConfig, opts?.configPath);
  const proposedServers = getServerNamesFromConfig(proposedConfig, opts?.configPath);
  const removedServers = [...targetServers].filter((s) => !proposedServers.has(s));
  const reportedNames = opts?.report?.servers
    ? new Set(opts.report.servers.map((s) => s.name))
    : null;
  return removedServers.filter((s) => {
    if (!expectedRemovals.has(s)) {
      if (reportedNames && !reportedNames.has(s)) {
        return false;
      }
      return true;
    }
    return false;
  });
}

/**
 * Stdio servers with no metered tools yet (discovery incomplete) must not be dropped.
 */
export function shouldPassThroughUnmeteredServer(
  serverName: string,
  originalConfig: unknown,
  meters: ToolMeter[],
  opts?: { report?: Report; discoveryInProgress?: boolean; configPath?: string }
): boolean {
  if (getRemoteServerNames(originalConfig, opts?.configPath).has(serverName)) {
    return true;
  }

  if (opts?.report?.servers) {
    const inReport = opts.report.servers.some((s) => s.name === serverName);
    if (!inReport) {
      return true;
    }
  }

  const status = serverStatusFromReport(opts?.report, serverName);
  if (status && isDiscoveryFailureStatus(status)) {
    return true;
  }

  const hasMeteredTools = meters.some((m) => m.server === serverName);
  if (hasMeteredTools) {
    return false;
  }

  if (opts?.discoveryInProgress) {
    return true;
  }

  return false;
}

export function computeConfigContentHash(content: string): string {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

export function loadExpectedRemovalsFromReport(reportPath: string, readJson: (p: string) => unknown): Set<string> | null {
  try {
    const report = readJson(reportPath) as Report;
    const removed = report.savings?.removedServers;
    if (!Array.isArray(removed)) {
      return null;
    }
    return new Set(removed);
  } catch {
    return null;
  }
}
