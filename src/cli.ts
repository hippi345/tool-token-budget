#!/usr/bin/env node
import { Command } from "commander";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { readConfigUtf8WithRetry } from "./config/readConfigWithRetry.js";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadToolsJson } from "./discover/fromToolsJson.js";
import { discoverFromMcpConfig, redactEnv } from "./discover/fromMcpConfig.js";
import { analyzeTools, analyzeToolsAsync, formatTextReport } from "./pipeline.js";
import { buildAnalyzeOptionsFromCli } from "./analyzeCliOptions.js";
import { isHfTokenizersPeerInstalled } from "./meter/hfTokenize.js";
import { apiConfiguredFlags } from "./meter/apiTokenCount.js";
import { parseJSON } from "./utils/json.js";
import { redactSecrets, sanitizeReport } from "./utils/redact.js";
import { formatHtml } from "./report/formatHtml.js";
import { formatSarif } from "./report/formatSarif.js";
import { writeArtifacts, type EmitFormat } from "./emit/writeArtifacts.js";
import { applyConfig } from "./apply/applyConfig.js";
import {
  isRecognizedMcpConfigShape,
  parseClientConfigContent,
  vscodeWorkspaceMcpPrecedenceWarning,
} from "./config/configSurfaces.js";
import {
  ALL_CLIENT_CONFIG_IDS,
  getClientConfigById,
  normalizeClientConfigId,
} from "./discover/clientConfigs.js";
import type { EmitProfile } from "./types.js";
import type { Report, Server, Tool } from "./types.js";
import { debounce } from "./utils/debounce.js";
import { Poller, validateWatchInterval } from "./poll/poller.js";
import { formatDiff } from "./poll/differ.js";
import { startServer } from "./ui/server.js";
import { ConfigLoadError } from "./config/configLoadError.js";
import {
  formatConfigLoadError,
  unrecognizedConfigShapeMessage,
} from "./config/formatConfigLoadError.js";
import { logOnce } from "./config/logOnce.js";
import { spawn } from "node:child_process";
import { attachUsageToReport } from "./usage/usageTrim.js";
import { scanToolUsage, type UsageScanResult } from "./usage/collectUsage.js";
import type { UsageLogRoots } from "./usage/paths.js";
import {
  defaultProposedFilename,
  resolveProposedPathForApply,
  isUiWatchDisabled,
  TOOL_TOKEN_BUDGET_EXPORT_DIR,
} from "./branding/artifactPaths.js";
import {
  syncMcpClients,
  SyncError,
  SYNC_ERROR_CODES,
  printSyncJsonError,
} from "./mcp/syncMcpClients.js";
import {
  EXIT_CONFIG_BUDGET,
  printBudgetWarnings,
  runPostAnalyzeHooks,
} from "./analyze/postAnalyze.js";
import { readAnalyzeHistory } from "./history/store.js";
import {
  formatHistoryJson,
  formatHistoryText,
  type HistoryFilter,
} from "./history/formatHistory.js";

function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } else if (process.platform === "win32") {
    // Windows: cmd /c start "" "<url>"
    // The empty string after start is the window title; without it, the URL becomes the title
    // Drop shell:true to avoid DEP0190 and prevent & injection (URLs with query params)
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
  } else {
    // Linux/Unix
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");

const EXIT_OK = 0;
const EXIT_BUDGET = 1;
const EXIT_USAGE = 2;

function resolveUsageLogRoots(usageLogDir: string | undefined): Partial<UsageLogRoots> | undefined {
  if (!usageLogDir) {
    return undefined;
  }
  const base = path.resolve(usageLogDir);
  return {
    claudeCode: path.join(base, "claude-code"),
    codex: path.join(base, "codex"),
    cursor: path.join(base, "cursor"),
  };
}

async function scanUsageFromCliOpts(opts: {
  since?: string;
  noUsage?: boolean;
  /** Commander maps --no-usage to `usage: false`. */
  usage?: boolean;
  usageLogDir?: string;
}): Promise<UsageScanResult | undefined> {
  if (opts.noUsage === true || opts.usage === false) {
    return undefined;
  }
  try {
    return await scanToolUsage({
      since: opts.since,
      logRoots: resolveUsageLogRoots(opts.usageLogDir),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(EXIT_USAGE);
  }
}

function meterAnalyzeOptsFromCli(
  opts: Record<string, unknown>
): ReturnType<typeof buildAnalyzeOptionsFromCli> {
  try {
    return buildAnalyzeOptionsFromCli(
      opts as Parameters<typeof buildAnalyzeOptionsFromCli>[0]
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(EXIT_USAGE);
  }
}

const uiWarnedRemoteServers = new Set<string>();

function isToolsJsonShape(raw: unknown): boolean {
  return Boolean(raw && typeof raw === "object" && Array.isArray((raw as { servers?: unknown }).servers));
}

function isMcpConfigShape(raw: unknown, configPath?: string): boolean {
  return isRecognizedMcpConfigShape(raw, configPath);
}

async function resolveClientConfigTarget(opts: {
  client?: string;
  configPath?: string;
  cwd?: string;
}): Promise<{ configPath?: string; profile?: EmitProfile }> {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.client && opts.configPath) {
    console.error("Use either --client <id> or a config path, not both.");
    process.exit(EXIT_USAGE);
  }
  if (opts.client) {
    const client = await getClientConfigById(opts.client, cwd);
    if (!client) {
      console.error(`Unknown --client id: ${opts.client}`);
      console.error(
        `Valid client ids: ${ALL_CLIENT_CONFIG_IDS.join(", ")} (alias: vscode → vscode-user)`
      );
      process.exit(EXIT_USAGE);
    }
    if (client.viewOnly) {
      console.error(`Client "${opts.client}" is view-only and cannot be used for emit/apply.`);
      process.exit(EXIT_USAGE);
    }
    return { configPath: client.path, profile: client.profile ?? undefined };
  }
  return { configPath: opts.configPath };
}

async function resolveTools(opts: {
  toolsJson?: string;
  configPath?: string;
  timeoutMs?: number;
  warnedRemoteServers?: Set<string>;
  /** UI mode: throw ConfigLoadError instead of exiting the process. */
  resilientLoad?: boolean;
  /** When set, discovery uses these bytes (must match on-disk file for UI reconcile). */
  configContent?: string;
  /** Test hook: runs after config bytes are read, before discovery. */
  afterConfigRead?: (content: string, configPath: string) => Promise<void>;
}): Promise<{ servers: Server[]; tools: Tool[]; configContent?: string }> {
  if (opts.toolsJson) {
    const resolved = path.resolve(opts.toolsJson);
    try {
      return await loadToolsJson(resolved);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const redacted = formatConfigLoadError(err);
      if (opts.resilientLoad) {
        throw new ConfigLoadError(redacted);
      }
      console.error(`Cannot load ${opts.toolsJson}: ${redacted}`);
      process.exit(EXIT_USAGE);
    }
  }
  if (opts.configPath) {
    const resolved = path.resolve(opts.configPath);
    try {
      const fileContent =
        opts.configContent ?? (await readConfigUtf8WithRetry(resolved));
      if (opts.afterConfigRead) {
        await opts.afterConfigRead(fileContent, resolved);
      }
      const globalHook = (
        globalThis as {
          __schemaBudgetTestAfterConfigRead?: (
            content: string,
            configPath: string
          ) => Promise<void>;
        }
      ).__schemaBudgetTestAfterConfigRead;
      if (globalHook) {
        await globalHook(fileContent, resolved);
      }

      const raw = parseClientConfigContent(fileContent, resolved) as unknown;
      if (isToolsJsonShape(raw)) {
        const loaded = await loadToolsJson(resolved);
        return { ...loaded, configContent: fileContent };
      }
      if (!isMcpConfigShape(raw, resolved)) {
        const shapeMsg = unrecognizedConfigShapeMessage();
        if (opts.resilientLoad) {
          throw new ConfigLoadError(shapeMsg);
        }
        console.error(
          `Unrecognized config shape in ${opts.configPath}. Expected mcpServers or tools-json { servers: [...] }.`
        );
        process.exit(EXIT_USAGE);
      }
      // Ensure we never log secrets from config
      void redactEnv(raw);
      const discovered = await discoverFromMcpConfig(resolved, {
        timeoutMs: opts.timeoutMs ?? 15_000,
        onWarn: (m) => console.error(m),
        warnedRemoteServers: opts.warnedRemoteServers,
        configContent: fileContent,
      });
      return { ...discovered, configContent: fileContent };
    } catch (err) {
      const redactedMsg = formatConfigLoadError(err);
      if (opts.resilientLoad) {
        throw new ConfigLoadError(redactedMsg);
      }
      console.error(`Cannot load ${opts.configPath}: ${redactedMsg}`);
      process.exit(EXIT_USAGE);
    }
  }
  console.error(
    "Provide a config path or --tools-json <file>. See tool-token-budget doctor."
  );
  process.exit(EXIT_USAGE);
}

function exitForReport(
  report: Report,
  opts: {
    budget?: number;
    failOn?: string;
    failOverBudget?: boolean;
    configBudgetExceeded?: boolean;
  }
): never {
  if (opts.failOverBudget && opts.configBudgetExceeded) {
    console.error("One or more user-config token budgets were exceeded.");
    process.exit(EXIT_CONFIG_BUDGET);
  }
  if (opts.budget !== undefined && report.totals.estTokens > opts.budget) {
    console.error(
      `Over budget: estimate ${report.totals.estTokens} > ${opts.budget}`
    );
    process.exit(EXIT_BUDGET);
  }
  if (opts.failOn) {
    const order = ["info", "warn", "error"] as const;
    const threshold = opts.failOn as (typeof order)[number];
    if (!order.includes(threshold)) {
      console.error(`Invalid --fail-on: ${opts.failOn}`);
      process.exit(EXIT_USAGE);
    }
    const idx = order.indexOf(threshold);
    const hit = report.findings.some(
      (f) => order.indexOf(f.severity) >= idx
    );
    if (hit) {
      console.error(`fail-on ${threshold}: lint findings present`);
      process.exit(EXIT_BUDGET);
    }
  }
  process.exit(EXIT_OK);
}

async function cmdAnalyze(
  configPath: string | undefined,
  opts: {
    client?: string;
    json?: boolean;
    html?: string;
    format?: string;
    sarif?: string;
    budget?: string;
    failOn?: string;
    toolsJson?: string;
    timeout?: string;
    watch?: boolean;
    watchInterval?: string;
    model?: string;
    models?: string;
    countMode?: string;
    framing?: string;
    cacheTokenizers?: string;
    apiCountMax?: string;
    verbose?: boolean;
    perTool?: boolean;
    since?: string;
    noUsage?: boolean;
    usageLogDir?: string;
    noHistory?: boolean;
    /** Commander sets `history: false` for `--no-history`. */
    history?: boolean;
    failOverBudget?: boolean;
  }
): Promise<void> {
  const clientTarget = await resolveClientConfigTarget({
    client: opts.client,
    configPath,
  });
  configPath = clientTarget.configPath;
  const analyzeClientId = opts.client;
  const analyzeOpts = meterAnalyzeOptsFromCli(opts);
  const perModelDetail = Boolean(opts.perTool || opts.verbose);
  if (opts.verbose) {
    const { setMeterVerbose } = await import("./meter/meterVerbose.js");
    setMeterVerbose(true);
  }
  const runAnalysis = async () => {
    const { servers, tools } = await resolveTools({
      toolsJson: opts.toolsJson,
      configPath,
      timeoutMs: opts.timeout !== undefined ? Number(opts.timeout) : undefined,
    });
    const report = analyzeOpts
      ? await analyzeToolsAsync(tools, servers, analyzeOpts)
      : analyzeTools(tools, servers);

    const usageScan = await scanUsageFromCliOpts(opts);
    let reportWithUsage = report;
    if (usageScan) {
      reportWithUsage = attachUsageToReport(report, usageScan);
    }

    const post = await runPostAnalyzeHooks(reportWithUsage, {
      clientId: analyzeClientId,
      noHistory: opts.noHistory === true || opts.history === false,
    });
    if (post.configError) {
      console.error(post.configError.message);
      process.exit(EXIT_USAGE);
    }
    printBudgetWarnings(post.budgetStatus);

    // Sanitize report before any output to prevent secret leaks
    const sanitized = sanitizeReport(post.report);

    if (opts.html) {
      const htmlPath = path.resolve(opts.html);
      await mkdir(path.dirname(htmlPath), { recursive: true });
      await writeFile(htmlPath, formatHtml(sanitized), "utf8");
      console.error(`Wrote HTML report: ${htmlPath}`);
    }

    if (opts.sarif) {
      const sarifPath = path.resolve(opts.sarif);
      await mkdir(path.dirname(sarifPath), { recursive: true });
      await writeFile(sarifPath, formatSarif(sanitized), "utf8");
      console.error(`Wrote SARIF report: ${sarifPath}`);
    }

    if (opts.format === "sarif") {
      console.log(formatSarif(sanitized));
    } else if (opts.json) {
      console.log(JSON.stringify(sanitized, null, 2));
    } else {
      console.log(formatTextReport(sanitized, { perModelDetail }));
    }

    return post;
  };

  const postResult = await runAnalysis();

  if (opts.watch) {
    const intervalSec = opts.watchInterval ? Number(opts.watchInterval) : 30;
    try {
      validateWatchInterval(intervalSec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(msg);
      process.exit(EXIT_USAGE);
    }

    console.error(`\nWatching for changes every ${intervalSec}s... (Ctrl+C to exit)`);
    
    // File watch for immediate re-run
    const watchPaths = [
      opts.toolsJson || configPath,
    ].filter(Boolean) as string[];

    const debouncedRerun = debounce(async () => {
      console.error("\n--- File changed, re-running analysis ---\n");
      try {
        await runAnalysis();
      } catch (err) {
        console.error("Analysis failed:", err);
      }
    }, 300);

    const watchers = watchPaths.map((p) => {
      const resolved = path.resolve(p!);
      return watch(resolved, {}, () => {
        debouncedRerun();
      });
    });

    // Polling for live discovery
    const poller = new Poller({
      intervalSec,
      discover: async () => {
        return resolveTools({
          toolsJson: opts.toolsJson,
          configPath,
          timeoutMs: opts.timeout !== undefined ? Number(opts.timeout) : undefined,
        });
      },
      analyze: (tools, servers) =>
        analyzeOpts
          ? analyzeTools(tools, servers, analyzeOpts)
          : analyzeTools(tools, servers),
      onSnapshot: (snapshot, diff) => {
        if (diff) {
          console.error("\n--- Changes detected ---");
          console.error(formatDiff(diff));
          console.error("");
        }
      },
      onError: (err) => {
        console.error("Poll error:", err);
      },
    });

    await poller.start();

    // Clean exit on Ctrl+C
    process.on("SIGINT", () => {
      console.error("\nStopping watch mode...");
      poller.stop();
      watchers.forEach((w) => w.close());
      process.exit(EXIT_OK);
    });

    // Keep process alive
    await new Promise(() => {});
  }

  exitForReport(postResult.report, {
    budget: opts.budget !== undefined ? Number(opts.budget) : undefined,
    failOn: opts.failOn,
    failOverBudget: opts.failOverBudget,
    configBudgetExceeded: postResult.budgetStatus.anyExceeded,
  });
}

async function cmdHistory(opts: {
  json?: boolean;
  client?: string;
  model?: string;
  limit?: string;
  since?: string;
}): Promise<void> {
  const { file, corrupt } = await readAnalyzeHistory();
  if (corrupt) {
    console.error("warn: analyze history file is corrupt or unreadable; showing empty history");
  }
  const filter: HistoryFilter = {
    client: opts.client,
    model: opts.model,
    since: opts.since,
    limit: opts.limit !== undefined ? Number(opts.limit) : undefined,
  };
  if (opts.json) {
    const payload = formatHistoryJson(file.entries, filter);
    if (payload.entries.length === 0) {
      console.log(
        JSON.stringify({
          entries: [],
          sparklines: { totals: "", byClient: {}, byModel: {} },
          message:
            "No analyze history yet. Run `tool-token-budget analyze` to record totals.",
        })
      );
      process.exit(EXIT_OK);
    }
    console.log(JSON.stringify(payload, null, 2));
    process.exit(EXIT_OK);
  }
  const text = formatHistoryText(file.entries, filter);
  console.log(text);
  process.exit(EXIT_OK);
}

async function cmdEmit(
  configPath: string | undefined,
  opts: {
    client?: string;
    format?: string;
    out?: string;
    keepHot?: string;
    keepPerServer?: string;
    disableServersOver?: string;
    profile?: string;
    proposedName?: string;
    toolsJson?: string;
    budget?: string;
    failOn?: string;
    timeout?: string;
    model?: string;
    models?: string;
    countMode?: string;
    framing?: string;
    cacheTokenizers?: string;
    apiCountMax?: string;
    since?: string;
    noUsage?: boolean;
    usageLogDir?: string;
  }
): Promise<void> {
  const clientTarget = await resolveClientConfigTarget({
    client: opts.client,
    configPath,
  });
  const effectiveConfigPath = clientTarget.configPath;
  const precedenceWarn = vscodeWorkspaceMcpPrecedenceWarning(process.cwd());
  if (precedenceWarn) {
    console.error(`warn: ${precedenceWarn}`);
  }

  const { servers, tools } = await resolveTools({
    toolsJson: opts.toolsJson,
    configPath: effectiveConfigPath,
    timeoutMs: opts.timeout !== undefined ? Number(opts.timeout) : undefined,
  });
  const analyzeOpts = meterAnalyzeOptsFromCli(opts);
  const report = analyzeOpts
    ? await analyzeToolsAsync(tools, servers, analyzeOpts)
    : analyzeTools(tools, servers);

  const usageScan = await scanUsageFromCliOpts(opts);
  let reportForEmit = report;
  if (usageScan) {
    reportForEmit = attachUsageToReport(report, usageScan);
  }

  const format = (opts.format ?? "both") as EmitFormat;
  if (!["mcp-json", "defer-hints", "both"].includes(format)) {
    console.error(`Invalid --format: ${opts.format}`);
    process.exit(EXIT_USAGE);
  }

  const profile = (opts.profile ?? clientTarget.profile) as EmitProfile | undefined;
  const allowedProfiles: EmitProfile[] = [
    "claude",
    "cursor",
    "generic",
    "vscode",
    "windsurf",
    "gemini-settings",
    "antigravity",
    "codex",
  ];
  if (profile && !allowedProfiles.includes(profile)) {
    console.error(`Invalid --profile: ${opts.profile}`);
    process.exit(EXIT_USAGE);
  }

  const outDir = path.resolve(opts.out ?? ".");
  
  // Build policy from flags
  const policy: { keepHot?: number; keepPerServer?: number; disableServersOver?: number } = {};
  const hasExplicitKeepPolicy = opts.keepHot !== undefined || opts.keepPerServer !== undefined;
  
  if (opts.keepHot !== undefined) {
    const keepHot = Number(opts.keepHot);
    if (!Number.isFinite(keepHot) || keepHot < 0) {
      console.error(`Invalid --keep-hot: ${opts.keepHot}`);
      process.exit(EXIT_USAGE);
    }
    policy.keepHot = keepHot;
  }

  if (opts.keepPerServer !== undefined) {
    const keepPerServer = Number(opts.keepPerServer);
    if (!Number.isFinite(keepPerServer) || keepPerServer < 0) {
      console.error(`Invalid --keep-per-server: ${opts.keepPerServer}`);
      process.exit(EXIT_USAGE);
    }
    policy.keepPerServer = keepPerServer;
  } else if (!hasExplicitKeepPolicy) {
    // Default behavior: keep at least 2 cheapest tools per server
    policy.keepPerServer = 2;
  }

  if (opts.disableServersOver !== undefined) {
    const disableServersOver = Number(opts.disableServersOver);
    if (!Number.isFinite(disableServersOver) || disableServersOver < 0) {
      console.error(`Invalid --disable-servers-over: ${opts.disableServersOver}`);
      process.exit(EXIT_USAGE);
    }
    policy.disableServersOver = disableServersOver;
  }

  // Load original config from mcp path when provided (independent of --tools-json metering)
  let originalConfig: unknown;
  if (effectiveConfigPath) {
    try {
      const resolved = path.resolve(effectiveConfigPath);
      const content = await readFile(resolved, "utf8");
      const { parseClientConfigContent } = await import("./config/configSurfaces.js");
      originalConfig = parseClientConfigContent(content, resolved);
    } catch {
      // If we can't load it, just continue without it
    }
  }

  const effectiveProfile = profile ?? "claude";
  const wantProposed =
    effectiveProfile === "cursor" ||
    format === "mcp-json" ||
    format === "both";

  const written = await writeArtifacts(outDir, reportForEmit, { 
    format, 
    policy,
    profile,
    proposedName: opts.proposedName,
    originalConfig,
    usageScan,
    mcpConfigPath:
      effectiveConfigPath && !opts.toolsJson
        ? path.resolve(effectiveConfigPath)
        : undefined,
    clientConfigPath:
      effectiveConfigPath && !opts.toolsJson
        ? path.resolve(effectiveConfigPath)
        : undefined,
  });
  for (const p of written) {
    console.log(`wrote ${p}`);
  }
  if (wantProposed && originalConfig === undefined) {
    console.log(
      "note: no proposed config written; pass a config path or --client <id> to emit one"
    );
  }
  exitForReport(reportForEmit, {
    budget: opts.budget !== undefined ? Number(opts.budget) : undefined,
    failOn: opts.failOn,
  });
}

async function cmdApply(
  opts: {
    client?: string;
    mcpConfig?: string;
    proposed?: string;
    backup: boolean;
    yes: boolean;
    dryRun?: boolean;
  },
  command?: Command
): Promise<void> {
  const mcpFromCli = command?.getOptionValueSource("mcpConfig") === "cli";
  const configPathArg =
    opts.client && !mcpFromCli ? undefined : opts.mcpConfig ?? "mcp.json";
  const clientTarget = await resolveClientConfigTarget({
    client: opts.client,
    configPath: configPathArg,
  });
  const mcpConfigPath = path.resolve(clientTarget.configPath || "mcp.json");
  const proposedFromCli = command?.getOptionValueSource("proposed") === "cli";
  const proposedPath = await resolveProposedPathForApply(
    mcpConfigPath,
    proposedFromCli ? opts.proposed : undefined
  );

  if (opts.yes && !opts.backup && opts.dryRun !== true) {
    console.error("Error: apply --yes requires --backup");
    process.exit(EXIT_USAGE);
  }

  // Explicit --dry-run flag or default dry-run (no --backup and --yes)
  const dryRun = opts.dryRun === true || (!opts.backup || !opts.yes);

  const result = await applyConfig({
    mcpConfigPath,
    proposedPath,
    dryRun,
    backup: opts.backup,
    yes: opts.yes,
  });

  if (!result.success) {
    console.error(`Error: ${result.error}`);
    process.exit(2);
  }

  if (result.diffSummary) {
    const { serversRemoved, serversKept, totalBefore, totalAfter } = result.diffSummary;
    console.log("Diff summary:");
    console.log(`  Servers before: ${totalBefore}`);
    console.log(`  Servers after:  ${totalAfter}`);
    if (serversRemoved.length > 0) {
      console.log(`  Removed: ${serversRemoved.join(", ")}`);
    }
    if (serversKept.length > 0) {
      console.log(`  Kept: ${serversKept.join(", ")}`);
    }
  }

  if (dryRun) {
    console.log("\nDry-run mode: no changes written.");
    console.log("To apply, run with: --backup --yes");
  } else if (result.noOp) {
    console.log("No changes; nothing written");
  } else {
    if (result.backupPath) {
      console.log(`\nBackup created: ${result.backupPath}`);
    }
    console.log(`Applied: ${mcpConfigPath}`);
  }

  process.exit(EXIT_OK);
}

async function cmdLintServer(opts: {
  toolsJson?: string;
  failOn?: string;
}): Promise<void> {
  if (!opts.toolsJson) {
    console.error("Error: --tools-json <file> is required for lint-server");
    process.exit(EXIT_USAGE);
  }

  let servers;
  let tools;
  try {
    const loaded = await loadToolsJson(path.resolve(opts.toolsJson));
    servers = loaded.servers;
    tools = loaded.tools;
  } catch (err) {
    const redacted = formatConfigLoadError(err);
    console.error(`Cannot load ${opts.toolsJson}: ${redacted}`);
    process.exit(EXIT_USAGE);
  }
  const report = analyzeTools(tools, servers);

  console.log("tool-token-budget lint-server - Author mode");
  console.log(`tokenizer: o200k_base (estimate)`);
  console.log(
    `totals: ~${report.totals.estTokens} tokens (estimate) across ${report.totals.toolCount} tools / ${report.totals.serverCount} servers\n`
  );

  if (report.findings.length === 0) {
    console.log("OK: No lint findings - schema is clean");
    process.exit(EXIT_OK);
  }

  const order = ["info", "warn", "error"] as const;
  const threshold = (opts.failOn || "warn") as (typeof order)[number];
  if (!order.includes(threshold)) {
    console.error(`Invalid --fail-on: ${opts.failOn}`);
    process.exit(EXIT_USAGE);
  }

  const idx = order.indexOf(threshold);
  const blockers = report.findings.filter(
    (f) => order.indexOf(f.severity) >= idx
  );

  console.log(`Lint findings (${report.findings.length}):`);
  for (const f of report.findings) {
    const icon = order.indexOf(f.severity) >= idx ? "x" : "*";
    console.log(
      `  ${icon} [${f.severity}] ${f.ruleId} ${f.server}::${f.tool} - ${f.message}`
    );
    if (f.suggestion) {
      console.log(`    -> ${f.suggestion}`);
    }
  }

  if (blockers.length > 0) {
    console.error(
      `\nFAILED: ${blockers.length} findings at or above --fail-on ${threshold}`
    );
    process.exit(EXIT_BUDGET);
  }

  console.log(`\nOK: All findings below --fail-on ${threshold}`);
  process.exit(EXIT_OK);
}

function syncCliUsageError(
  json: boolean | undefined,
  code: string,
  message: string,
  details: Record<string, unknown> = {}
): never {
  if (json) {
    printSyncJsonError(new SyncError(code as (typeof SYNC_ERROR_CODES)[keyof typeof SYNC_ERROR_CODES], message, details));
  } else {
    console.error(message);
  }
  process.exit(EXIT_USAGE);
}

async function cmdSync(opts: {
  from?: string;
  to?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}): Promise<void> {
  if (!opts.from) {
    syncCliUsageError(
      opts.json,
      SYNC_ERROR_CODES.MISSING_FROM,
      "Error: sync requires --from <client-id>"
    );
  }
  if (!opts.to) {
    syncCliUsageError(
      opts.json,
      SYNC_ERROR_CODES.MISSING_TO,
      "Error: sync requires --to <client-id|all>"
    );
  }

  const toClient = opts.to === "all" ? "all" : opts.to;

  try {
    await syncMcpClients({
      fromClientId: opts.from,
      toClientId: toClient,
      dryRun: opts.dryRun,
      yes: opts.yes,
      json: opts.json,
    });
    process.exit(EXIT_OK);
  } catch (err) {
    if (err instanceof SyncError) {
      if (opts.json) {
        printSyncJsonError(err);
      } else {
        console.error(err.message);
      }
      process.exit(EXIT_USAGE);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      printSyncJsonError(new SyncError(SYNC_ERROR_CODES.UNEXPECTED, message, {}));
    } else {
      console.error(message);
    }
    process.exit(EXIT_USAGE);
  }
}

async function cmdDoctor(): Promise<void> {
  console.log(`node: ${process.version}`);
  console.log(`engine requirement: >=20`);
  const apiFlags = apiConfiguredFlags();
  console.log(
    `optional token APIs configured: anthropic=${apiFlags.anthropic} gemini=${apiFlags.gemini}`
  );
  try {
    const { estimateTokens } = await import("./meter/tokenize.js");
    const n = estimateTokens("doctor smoke");
    console.log(`tokenizer o200k_base loaded (sample estimate: ${n} tokens)`);
  } catch (err) {
    console.error("tokenizer failed to load", err);
    process.exit(EXIT_BUDGET);
  }
  const hfPeer = await isHfTokenizersPeerInstalled();
  console.log(
    `@huggingface/tokenizers peer: ${hfPeer ? "installed" : "missing (npm i @huggingface/tokenizers for exact open-weight counts)"}`
  );
  const fixture = path.join(PKG_ROOT, "fixtures", "tools-tiny.json");
  try {
    const { servers, tools } = await loadToolsJson(fixture);
    const report = analyzeTools(tools, servers);
    const sanitized = sanitizeReport(report);
    console.log(formatTextReport(sanitized));
    console.log("doctor: ok");
    process.exit(EXIT_OK);
  } catch (err) {
    console.error("doctor fixture analyze failed", err);
    process.exit(EXIT_BUDGET);
  }
}

const program = new Command();
program
  .name("tool-token-budget")
  .description(
    "Tool Token Budget — measure MCP tool schema token cost, lint bloat, emit keep/defer proposals"
  )
  .version("1.0.0")
  .showHelpAfterError()
  .exitOverride((err) => {
    // commander uses exitCode 1 for help; map usage errors to 2
    if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
      process.exit(EXIT_OK);
    }
    process.exit(EXIT_USAGE);
  });

program
  .command("analyze")
  .description("Discover, meter, lint, and print report")
  .argument("[configPath]", "mcp.json or tools-json path")
  .option("--json", "print report JSON to stdout")
  .option("--html <path>", "write HTML report to path")
  .option("--format <fmt>", "output format: json|sarif (default: text)")
  .option("--sarif <path>", "write SARIF report to path")
  .option("--budget <tokens>", "exit 1 if total estimate exceeds")
  .option("--fail-on <severity>", "exit 1 if findings at or above severity")
  .option("--tools-json <file>", "offline tools fixture (bypass live discover)")
  .option("--timeout <ms>", "stdio discover timeout", "15000")
  .option("--watch", "watch config/tools files and re-run on changes")
  .option("--watch-interval <sec>", "polling interval for watch mode (default: 30, min: 10)")
  .option("--mcp-config <path>", "path to mcp.json (alternative to positional config path)")
  .option("--client <id>", "client config id (resolves config path)")
  .option("--model <id>", "primary model for per-model token columns")
  .option("--models <csv>", "extra model ids (comma-separated)")
  .option("--count-mode <mode>", "offline|api|auto", "offline")
  .option("--framing <profile>", "cursor-catalog|cursor-full|anthropic-tools|openai-tools|vscode-flat|gemini-functions")
  .option("--cache-tokenizers <dir>", "HF tokenizer cache directory")
  .option("--api-count-max <n>", "max HTTP token-count API calls per run", "20")
  .option("--verbose", "log tokenizer fallback reasons to stderr")
  .option(
    "--per-tool",
    "include per-model framing overhead lines in text output (does not change default output)"
  )
  .option("--since <window>", "usage log window (default 30d); ISO date or NNd")
  .option("--no-usage", "skip local client log usage scan")
  .option(
    "--usage-log-dir <dir>",
    "override log roots for tests (expects claude-code/, codex/, cursor/ subdirs)"
  )
  .option("--no-history", "do not append this run to local analyze history")
  .option(
    "--fail-over-budget",
    `exit ${EXIT_CONFIG_BUDGET} when a user-config token budget is exceeded`
  )
  .action(async (configPath: string | undefined, opts) => {
    if (opts.mcpConfig && configPath) {
      console.error("Use either a positional config path or --mcp-config, not both.");
      process.exit(EXIT_USAGE);
    }
    const pathArg = opts.mcpConfig ?? configPath;
    if (opts.client && pathArg) {
      console.error("Use either --client <id> or a config path, not both.");
      process.exit(EXIT_USAGE);
    }
    await cmdAnalyze(pathArg, opts);
  });

program
  .command("emit")
  .description("Analyze and write sibling proposal artifacts")
  .argument("[configPath]", "mcp.json or tools-json path")
  .option("--format <fmt>", "mcp-json|defer-hints|both", "both")
  .option("--out <dir>", "output directory", ".")
  .option("--keep-hot <n>", "N lowest-estimate tools stay hot (global, explicit opt-in)")
  .option("--keep-per-server <n>", "keep up to N cheapest tools per server (default: 2)")
  .option("--disable-servers-over <tokens>", "disable entire servers over token threshold")
  .option("--client <id>", "client config id (same as GUI picker)")
  .option(
    "--profile <type>",
    "claude|cursor|generic|vscode|windsurf|gemini-settings|antigravity|codex"
  )
  .option("--proposed-name <name>", "custom name for proposed config", defaultProposedFilename())
  .option("--tools-json <file>", "offline tools fixture")
  .option("--budget <tokens>", "exit 1 if over budget")
  .option("--fail-on <severity>", "exit 1 on lint severity")
  .option("--timeout <ms>", "stdio discover timeout", "15000")
  .option("--model <id>", "primary model for per-model token columns in report.json")
  .option("--models <csv>", "extra model ids (comma-separated)")
  .option("--count-mode <mode>", "offline|api|auto", "offline")
  .option("--framing <profile>", "client framing override for token counting")
  .option("--cache-tokenizers <dir>", "HF tokenizer cache directory")
  .option("--api-count-max <n>", "max API count calls per run", "20")
  .option("--since <window>", "usage log window (default 30d); ISO date or NNd")
  .option("--no-usage", "skip local client log usage scan")
  .option(
    "--usage-log-dir <dir>",
    "override log roots for tests (expects claude-code/, codex/, cursor/ subdirs)"
  )
  .action(async (configPath: string | undefined, opts) => {
    await cmdEmit(configPath, opts);
  });

program
  .command("apply")
  .description("Apply proposed config to mcp.json (default: dry-run)")
  .option("--client <id>", "client config id (resolves config path)")
  .option("--mcp-config <path>", "path to mcp.json")
  .option("--proposed <path>", "path to proposed config", defaultProposedFilename())
  .option("--dry-run", "show diff without applying (default behavior)")
  .option("--backup", "create timestamped backup before writing")
  .option("--yes", "confirm live replacement (requires --backup)")
  .action(async (opts, command) => {
    await cmdApply(opts, command);
  });

program
  .command("lint-server")
  .description("Author mode: lint a single server's tools (fail on bloat)")
  .option("--tools-json <file>", "tools JSON file (required)")
  .option("--fail-on <severity>", "exit 1 on lint severity", "warn")
  .action(async (opts: { toolsJson?: string; failOn?: string }) => {
    await cmdLintServer(opts);
  });

program
  .command("doctor")
  .description("Node version, tokenizer, fixture smoke")
  .action(async () => {
    await cmdDoctor();
  });

program
  .command("history")
  .description("Show local analyze token totals over time (sparklines)")
  .option("--json", "machine-readable history and sparklines")
  .option("--client <id>", "filter to runs that recorded this --client id")
  .option("--model <id>", "filter to runs that include this model id")
  .option("--limit <n>", "only show the last N matching entries")
  .option("--since <iso>", "only entries at or after this ISO timestamp")
  .action(async (opts: {
    json?: boolean;
    client?: string;
    model?: string;
    limit?: string;
    since?: string;
  }) => {
    await cmdHistory(opts);
  });

program
  .command("sync")
  .description("Copy MCP server definitions from one client config to another")
  .requiredOption("--from <client-id>", "source client id (same ids as --client)")
  .requiredOption("--to <client-id|all>", "target client id, or all other detected clients")
  .option("--dry-run", "preview changes without writing (no backups)")
  .option("--yes", "apply without confirmation prompt (writes backups before changes)")
  .option("--json", "print plan/result or errors as JSON on stdout")
  .action(async (opts: {
    from?: string;
    to?: string;
    dryRun?: boolean;
    yes?: boolean;
    json?: boolean;
  }) => {
    await cmdSync(opts);
  });

program
  .command("ui")
  .description("Start local web UI (preview)")
  .argument("[configPath]", "mcp.json or tools-json path")
  .option("--port <number>", "server port (default: random)")
  .option("--no-open", "print URL instead of opening browser")
  .option("--watch-interval <sec>", "polling interval (default: 30, min: 10)")
  .option("--client <id>", "client config id (resolves config path)")
  .option("--tools-json <file>", "offline tools fixture")
  .option("--timeout <ms>", "stdio discover timeout", "15000")
  .option(
    "--export-dir <dir>",
    `root directory for exports (Tool Token Budget default: <cwd>/${TOOL_TOKEN_BUDGET_EXPORT_DIR})`
  )
  .option("--model <id>", "default model for GUI per-model columns")
  .option("--models <csv>", "extra model ids for GUI columns")
  .option("--count-mode <mode>", "offline|api|auto", "offline")
  .option("--framing <profile>", "client framing override for token counting")
  .option("--cache-tokenizers <dir>", "HF tokenizer cache directory")
  .option("--api-count-max <n>", "max API count calls per run", "20")
  .action(async (configPath: string | undefined, opts: {
    port?: string;
    open?: boolean;
    watchInterval?: string;
    toolsJson?: string;
    timeout?: string;
    exportDir?: string;
    model?: string;
    models?: string;
    countMode?: string;
    framing?: string;
    cacheTokenizers?: string;
    apiCountMax?: string;
  }) => {
    await cmdUi(configPath, opts);
  });

async function cmdUi(
  configPath: string | undefined,
  opts: {
    client?: string;
    port?: string;
    open?: boolean;
    watchInterval?: string;
    toolsJson?: string;
    timeout?: string;
    exportDir?: string;
    model?: string;
    models?: string;
    countMode?: string;
    framing?: string;
    cacheTokenizers?: string;
    apiCountMax?: string;
  }
): Promise<void> {
  const meterAnalyzeOpts = meterAnalyzeOptsFromCli(opts);
  const clientTarget = await resolveClientConfigTarget({
    client: opts.client,
    configPath,
  });
  configPath = clientTarget.configPath;
  // Validate that either configPath or toolsJson is provided BEFORE starting server
  if (!configPath && !opts.toolsJson) {
    console.error(
      "Provide a config path or --tools-json <file>. See tool-token-budget doctor."
    );
    process.exit(EXIT_USAGE);
  }

  const intervalSec = opts.watchInterval ? Number(opts.watchInterval) : 30;
  try {
    validateWatchInterval(intervalSec);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(EXIT_USAGE);
  }

  let currentReport: Report | null = null;
  let initialDiscoveryPending = true;
  let originalConfig: unknown;
  let resolvedConfigPath: string | undefined;

  // Load and validate config before binding the UI server
  if (configPath && !opts.toolsJson) {
    resolvedConfigPath = path.resolve(configPath);
    try {
      const { parseClientConfigContent } = await import("./config/configSurfaces.js");
      originalConfig = parseClientConfigContent(
        await readConfigUtf8WithRetry(resolvedConfigPath),
        resolvedConfigPath
      );
    } catch (err) {
      const redacted = formatConfigLoadError(err);
      console.error(`Cannot load ${configPath}: ${redacted}`);
      process.exit(EXIT_USAGE);
    }
  }

  let initialServers: Server[];
  let initialTools: Tool[];
  let initialAnalyzedContent: string | undefined;
  try {
    if (!opts.toolsJson) {
      console.error("Discovering servers...");
    }
    const resolved = await resolveTools({
      toolsJson: opts.toolsJson,
      configPath,
      timeoutMs: opts.timeout !== undefined ? Number(opts.timeout) : undefined,
      warnedRemoteServers: uiWarnedRemoteServers,
    });
    initialServers = resolved.servers;
    initialTools = resolved.tools;
    currentReport = meterAnalyzeOpts
      ? await analyzeToolsAsync(initialTools, initialServers, meterAnalyzeOpts)
      : analyzeTools(initialTools, initialServers);
    if (resolvedConfigPath) {
      initialAnalyzedContent = await readConfigUtf8WithRetry(resolvedConfigPath);
    }
  } finally {
    initialDiscoveryPending = false;
  }

  // Declare poller variable so we can reference it in the callback
  let poller: Poller;
  let lastGoodServers = initialServers;
  let lastGoodTools = initialTools;
  let lastDiscoveredConfigContent = initialAnalyzedContent;
  const configLoadState = { error: null as string | null };

  const discoverForUi = async (): Promise<{ servers: Server[]; tools: Tool[] }> => {
    try {
      const resolved = await resolveTools({
        toolsJson: opts.toolsJson,
        configPath,
        timeoutMs: opts.timeout !== undefined ? Number(opts.timeout) : undefined,
        warnedRemoteServers: uiWarnedRemoteServers,
        resilientLoad: Boolean(resolvedConfigPath || opts.toolsJson),
      });
      configLoadState.error = null;
      lastGoodServers = resolved.servers;
      lastGoodTools = resolved.tools;
      if (resolved.configContent) {
        lastDiscoveredConfigContent = resolved.configContent;
      }
      return { servers: resolved.servers, tools: resolved.tools };
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        configLoadState.error = err.message;
        logOnce(
          "config-load-error",
          `Cannot load config (will retry): ${err.message}`
        );
        return { servers: lastGoodServers, tools: lastGoodTools };
      }
      throw err;
    }
  };

  const server = await startServer({
    port: opts.port ? Number(opts.port) : undefined,
    onReady: (url) => {
      console.log(`Tool Token Budget UI running at: ${url}`);
      if (opts.open !== false) {
        try {
          openBrowser(url);
        } catch {
          console.error("Could not open browser automatically. Open the URL manually.");
        }
      }
    },
    getReport: () => currentReport,
    isDiscoveryInProgress: () => initialDiscoveryPending,
    configPath: resolvedConfigPath,
    originalConfig,
    cwd: process.cwd(),
    exportDir: opts.exportDir ? path.resolve(opts.exportDir) : undefined,
    watchInterval: intervalSec,
    reportSource: opts.toolsJson ? 'tools-json' : 'config',
    initialAnalyzedContent,
    getConfigLoadError: () => configLoadState.error,
    meterAnalyzeOpts: meterAnalyzeOpts ?? undefined,
    defaultClientId: opts.client
      ? normalizeClientConfigId(opts.client)
      : undefined,
    onWatchIntervalChange: (newIntervalSec: number) => {
      console.error(`Watch interval changed to ${newIntervalSec}s`);
      if (poller) {
        poller.setInterval(newIntervalSec);
        void poller.runNow();
      }
    },
  });

  server.broadcast({
    timestamp: new Date().toISOString(),
    servers: initialServers,
    tools: initialTools,
    report: currentReport,
  }, null);

  // Start polling
  poller = new Poller({
    intervalSec,
    discover: discoverForUi,
    analyze: (tools, servers) =>
      meterAnalyzeOpts
        ? analyzeTools(tools, servers, meterAnalyzeOpts)
        : analyzeTools(tools, servers),
    onSnapshot: async (snapshot, diff) => {
      currentReport = snapshot.report;
      if (resolvedConfigPath && !configLoadState.error && lastDiscoveredConfigContent) {
        server.reconcileBaselineAfterPoll(lastDiscoveredConfigContent, snapshot.report);
      }
      server.broadcast(snapshot, diff);
      if (diff) {
        console.error("Changes detected at", snapshot.timestamp);
      }
    },
    onError: (err) => {
      console.error("Poll error:", err);
    },
  });

  await poller.start();

  let configWatcher: ReturnType<typeof watch> | null = null;
  if (
    resolvedConfigPath &&
    !isUiWatchDisabled() &&
    process.platform !== "win32"
  ) {
    let debounce: NodeJS.Timeout | null = null;
    configWatcher = watch(
      resolvedConfigPath,
      { persistent: false },
      () => {
        if (debounce) {
          clearTimeout(debounce);
        }
        debounce = setTimeout(() => {
          poller.runNow().catch((err) => {
            console.error("Poll error:", err);
          });
        }, 300);
      }
    );
  }

  // Clean exit on Ctrl+C
  process.on("SIGINT", async () => {
    console.error("\nStopping server...");
    poller.stop();
    configWatcher?.close();
    await server.close();
    process.exit(EXIT_OK);
  });

  // Keep process alive
  await new Promise(() => {});
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    // exitOverride already handled commander errors
    if (err && typeof err === "object" && "code" in err) {
      process.exit(EXIT_USAGE);
    }
    console.error(err);
    process.exit(EXIT_USAGE);
  }
}

main();
