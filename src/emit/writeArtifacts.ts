import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { Report, ToolMeter, EmitProfile, PolicyOptions, SavingsSummary } from "../types.js";
import { selectHotTools, selectHotToolsWithPolicy, toolKey } from "./keepHot.js";
import { redactSecrets, sanitizeReport } from "../utils/redact.js";
import { shouldPassThroughUnmeteredServer, computeConfigContentHash } from "../mcp/configGuards.js";
import {
  logicalConfigForProposal,
  mergeProposedOntoClientConfig,
} from "../config/configSurfaces.js";
import { keepProposalWritePath } from "./keepArtifact.js";
import { defaultProposedFilename } from "../branding/artifactPaths.js";
import type { UsageScanResult } from "../usage/collectUsage.js";
import {
  applyUsageAwareHotSet,
  usageDeferSavingsTokens,
  hasUsageSignal,
} from "../usage/usageTrim.js";

export { selectHotTools };

export type EmitFormat = "mcp-json" | "defer-hints" | "both";

export interface WriteArtifactsOpts {
  keepHot?: number;
  format: EmitFormat;
  profile?: EmitProfile;
  proposedName?: string;
  policy?: PolicyOptions;
  originalConfig?: unknown;
  /** When set, SHA-256 of this file is stored on report.json for apply consistency checks. */
  mcpConfigPath?: string;
  /** When set with originalConfig, proposed file uses client on-disk shape (adapters). */
  clientConfigPath?: string;
  /** When set on emit, never-used tools are removed from the hot set. */
  usageScan?: UsageScanResult;
}

/** Claude-oriented defer_loading map keyed by server::name. */
export function buildDeferHints(
  meters: ToolMeter[],
  hot: Set<string>
): {
  version: 1;
  note: string;
  tools: Record<string, { server: string; name: string; defer_loading: boolean; estTokens: number }>;
} {
  const tools: Record<
    string,
    { server: string; name: string; defer_loading: boolean; estTokens: number }
  > = {};
  for (const m of meters) {
    const key = toolKey(m.server, m.name);
    tools[key] = {
      server: m.server,
      name: m.name,
      defer_loading: !hot.has(key),
      estTokens: m.estTokens,
    };
  }
  return {
    version: 1,
    note: "Claude-oriented defer_loading hints. Cursor may need enable/disable or an on-demand proxy instead. Token counts are estimates.",
    tools,
  };
}

/** Slim keep proposal: keepHot vs defer tool keys. */
export function buildKeepProposal(
  meters: ToolMeter[],
  hot: Set<string>
): {
  version: 1;
  note: string;
  keepHot: string[];
  defer: string[];
  byServer: Record<string, { keepHot: string[]; defer: string[] }>;
} {
  const keepHot: string[] = [];
  const defer: string[] = [];
  const byServer: Record<string, { keepHot: string[]; defer: string[] }> = {};
  for (const m of meters) {
    const key = toolKey(m.server, m.name);
    if (!byServer[m.server]) {
      byServer[m.server] = { keepHot: [], defer: [] };
    }
    if (hot.has(key)) {
      keepHot.push(key);
      byServer[m.server].keepHot.push(m.name);
    } else {
      defer.push(key);
      byServer[m.server].defer.push(m.name);
    }
  }
  keepHot.sort();
  defer.sort();
  return {
    version: 1,
    note: "Proposal only - does not overwrite your mcp.json. keep-hot = N lowest estTokens tools.",
    keepHot,
    defer,
    byServer,
  };
}

/**
 * Calculate savings summary for a given hot set.
 */
export function calculateSavings(
  meters: ToolMeter[],
  hot: Set<string>,
  disabledServers: Set<string>
): SavingsSummary {
  const currentEstTokens = meters.reduce((sum, m) => sum + m.estTokens, 0);
  const proposedEstTokens = meters
    .filter(m => hot.has(toolKey(m.server, m.name)) && !disabledServers.has(m.server))
    .reduce((sum, m) => sum + m.estTokens, 0);
  const savedEstTokens = currentEstTokens - proposedEstTokens;
  const savedPct = currentEstTokens > 0 ? (savedEstTokens / currentEstTokens) * 100 : 0;

  // Count deferred tools (not hot, but server not disabled)
  const deferredToolsCount = meters.filter(
    m => !hot.has(toolKey(m.server, m.name)) && !disabledServers.has(m.server)
  ).length;

  return {
    currentEstTokens,
    proposedEstTokens,
    savedEstTokens,
    savedPct: Math.round(savedPct * 100) / 100,
    deferredToolsCount,
    removedServersCount: disabledServers.size,
    removedServers: Array.from(disabledServers).sort(),
  };
}

/**
 * Build a proposed MCP config with servers/tools disabled based on policy.
 * Returns the proposed config and the set of all removed servers (both explicitly disabled and zero-hot).
 */
export interface BuildProposedMcpConfigOpts {
  report?: Report;
  discoveryInProgress?: boolean;
}

export function buildProposedMcpConfig(
  originalConfig: unknown,
  hot: Set<string>,
  disabledServers: Set<string>,
  meters: ToolMeter[],
  buildOpts?: BuildProposedMcpConfigOpts
): { proposed: unknown; allRemovedServers: Set<string> } {
  if (!originalConfig || typeof originalConfig !== "object") {
    return { proposed: { mcpServers: {} }, allRemovedServers: new Set() };
  }

  const orig = originalConfig as Record<string, unknown>;
  const mcpServers = (orig.mcpServers || {}) as Record<string, unknown>;
  const proposed: Record<string, unknown> = {};
  const allRemovedServers = new Set<string>(disabledServers);

  // Build a map of what tools each server has
  const serverTools = new Map<string, Set<string>>();
  for (const m of meters) {
    if (!serverTools.has(m.server)) {
      serverTools.set(m.server, new Set());
    }
    serverTools.get(m.server)!.add(m.name);
  }

  const reportedServerNames = new Set(
    buildOpts?.report?.servers?.map((s) => s.name) ?? []
  );

  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    // Skip explicitly disabled servers
    if (disabledServers.has(serverName)) {
      continue;
    }

    const configDisabledInSource =
      buildOpts?.report?.servers?.find((s) => s.name === serverName)?.status ===
      "config_disabled";
    if (configDisabledInSource) {
      proposed[serverName] = redactSecrets(serverConfig);
      continue;
    }

    // Never drop servers that were not part of the analyzed report (defense in depth)
    if (buildOpts?.report && reportedServerNames.size > 0 && !reportedServerNames.has(serverName)) {
      proposed[serverName] = redactSecrets(serverConfig);
      continue;
    }

    if (
      shouldPassThroughUnmeteredServer(serverName, originalConfig, meters, {
        report: buildOpts?.report,
        discoveryInProgress: buildOpts?.discoveryInProgress,
      })
    ) {
      proposed[serverName] = redactSecrets(serverConfig);
      continue;
    }

    // Check if any tools from this server are hot
    const tools = serverTools.get(serverName) || new Set();
    const hasHotTools = Array.from(tools).some((toolName) =>
      hot.has(toolKey(serverName, toolName))
    );

    if (hasHotTools) {
      // Redact secrets before adding to proposed config
      proposed[serverName] = redactSecrets(serverConfig);
    } else {
      // Server has zero hot tools, count as removed
      allRemovedServers.add(serverName);
    }
  }

  return {
    proposed: {
      ...orig,
      mcpServers: proposed,
    },
    allRemovedServers,
  };
}

/** Build proposed on-disk config for a specific client file (adapters). */
export function buildClientProposedMcpConfig(
  configPath: string,
  originalParsed: unknown,
  hot: Set<string>,
  disabledServers: Set<string>,
  meters: ToolMeter[],
  buildOpts?: BuildProposedMcpConfigOpts
): { proposed: unknown; allRemovedServers: Set<string> } {
  const logicalOriginal = logicalConfigForProposal(originalParsed, configPath);
  const { proposed: logicalProposed, allRemovedServers } = buildProposedMcpConfig(
    logicalOriginal,
    hot,
    disabledServers,
    meters,
    buildOpts
  );
  return {
    proposed: mergeProposedOntoClientConfig(
      originalParsed,
      configPath,
      logicalProposed
    ),
    allRemovedServers,
  };
}

/** Write sibling artifacts under outDir. Always writes report.json. */
export async function writeArtifacts(
  outDir: string,
  report: Report,
  opts: WriteArtifactsOpts
): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  
  // Determine hot set and disabled servers based on policy
  let hot: Set<string>;
  let disabledServers = new Set<string>();
  
  // Use policy if provided, otherwise use default per-server keeping
  const policy = opts.policy || { keepPerServer: 2 };
  let result = selectHotToolsWithPolicy(report.tools, policy);
  let usageDeferKeys = new Set<string>();
  if (opts.usageScan && hasUsageSignal(opts.usageScan)) {
    const usageResult = applyUsageAwareHotSet(report.tools, policy, opts.usageScan);
    result = { hot: usageResult.hot, disabledServers: usageResult.disabledServers };
    usageDeferKeys = usageResult.usageDeferKeys;
  }
  hot = result.hot;
  disabledServers = result.disabledServers;

  // Calculate initial savings (will be updated later if we have originalConfig)
  let savings = calculateSavings(report.tools, hot, disabledServers);
  const usageDeferSavings = usageDeferSavingsTokens(report.tools, usageDeferKeys);
  if (usageDeferSavings > 0) {
    savings = { ...savings, usageDeferSavingsEstTokens: usageDeferSavings };
  }
  let reportWithSavings: Report = { ...report, savings };

  if (opts.mcpConfigPath) {
    try {
      const sourceContent = await readFile(opts.mcpConfigPath, "utf8");
      reportWithSavings = {
        ...reportWithSavings,
        sourceConfigHash: computeConfigContentHash(sourceContent),
      };
    } catch {
      // omit hash if source unreadable
    }
  }

  // Sanitize secrets before writing report.json
  const sanitizedReport = sanitizeReport(reportWithSavings);

  const reportPath = path.join(outDir, "report.json");
  await writeFile(reportPath, JSON.stringify(sanitizedReport, null, 2) + "\n", "utf8");
  written.push(reportPath);

  // Determine what to write based on profile
  const profile = opts.profile || "claude";
  const wantDefer = (profile === "claude" || opts.format === "defer-hints" || opts.format === "both") && profile !== "generic";
  const wantKeep = opts.format === "mcp-json" || opts.format === "both" || profile === "generic";
  const wantProposed = profile === "cursor" || opts.format === "mcp-json" || opts.format === "both";

  if (wantDefer) {
    const p = path.join(outDir, "defer-hints.json");
    await writeFile(
      p,
      JSON.stringify(buildDeferHints(report.tools, hot), null, 2) + "\n",
      "utf8"
    );
    written.push(p);
  }

  if (wantKeep) {
    const p = keepProposalWritePath(outDir);
    await writeFile(
      p,
      JSON.stringify(buildKeepProposal(report.tools, hot), null, 2) + "\n",
      "utf8"
    );
    written.push(p);
  }

  // Write proposed MCP config for cursor profile or when explicitly requested
  if (wantProposed && opts.originalConfig) {
    const proposedName = opts.proposedName || defaultProposedFilename();
    const p = path.join(outDir, proposedName);
    const buildProposed = opts.clientConfigPath
      ? () =>
          buildClientProposedMcpConfig(
            opts.clientConfigPath!,
            opts.originalConfig,
            hot,
            disabledServers,
            report.tools,
            { report }
          )
      : () =>
          buildProposedMcpConfig(
            opts.originalConfig,
            hot,
            disabledServers,
            report.tools,
            { report }
          );
    const { proposed, allRemovedServers } = buildProposed();
    
    // Update disabledServers to include all removed servers for warnings
    disabledServers = allRemovedServers;
    
    // Warn if any servers are being removed
    if (disabledServers.size > 0) {
      const serverList = Array.from(disabledServers).sort().join(", ");
      console.error(`\n⚠️  WARNING: Removing ${disabledServers.size} server(s): ${serverList}`);
      if (opts.policy?.disableServersOver !== undefined) {
        console.error(`    Reason: Server total exceeds --disable-servers-over threshold`);
      } else {
        console.error(`    Reason: No hot tools kept from these servers`);
      }
      console.error();
    }
    
    // Recalculate savings with all removed servers
    const finalSavings = calculateSavings(report.tools, hot, disabledServers);
    reportWithSavings.savings = {
      ...finalSavings,
      ...(usageDeferSavings > 0
        ? { usageDeferSavingsEstTokens: usageDeferSavings }
        : {}),
    };
    
    // Rewrite report with updated savings (sanitize again)
    if (opts.mcpConfigPath && !reportWithSavings.sourceConfigHash) {
      try {
        const sourceContent = await readFile(opts.mcpConfigPath, "utf8");
        reportWithSavings = {
          ...reportWithSavings,
          sourceConfigHash: computeConfigContentHash(sourceContent),
        };
      } catch {
        // omit
      }
    }

    const finalSanitized = sanitizeReport(reportWithSavings);
    await writeFile(reportPath, JSON.stringify(finalSanitized, null, 2) + "\n", "utf8");
    
    // Proposed config is redacted per-server in buildProposedMcpConfig (including remote passthrough)
    await writeFile(
      p,
      JSON.stringify(proposed, null, 2) + "\n",
      "utf8"
    );
    written.push(p);
  }

  return written;
}
