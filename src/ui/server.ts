import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, copyFile, rename, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Report, PolicyOptions, Tool } from "../types.js";
import type { AnalyzeOptions } from "../analyzeOptions.js";
import { analyzeToolsAsync } from "../pipeline.js";
import {
  listPresetModelsForUi,
  isExperimentalModelId,
} from "../meter/modelCatalog.js";
import { validateModelIdsPayload } from "../meter/modelIdValidation.js";
import { validateModelCountsApiPayload } from "../meter/cliMeterValidation.js";
import { apiConfiguredFlags } from "../meter/apiTokenCount.js";
import type { Snapshot, Diff } from "../poll/differ.js";
import { redactEnv } from "../discover/fromMcpConfig.js";
import { detectClientConfigs, getClientConfigById, type ClientConfig } from "../discover/clientConfigs.js";
import { selectHotToolsWithPolicy, toolKey } from "../emit/keepHot.js";
import {
  buildProposedMcpConfig,
  buildClientProposedMcpConfig,
  buildKeepProposal,
  buildDeferHints,
  calculateSavings,
} from "../emit/writeArtifacts.js";
import { keepProposalWritePath } from "../emit/keepArtifact.js";
import { defaultExportDirForCwd } from "../branding/artifactPaths.js";
import {
  getServerNamesFromClientConfig,
  parseClientConfigContent,
  getConfigSurface,
  proposedExportFilenameForClient,
  isRecognizedMcpConfigShape,
} from "../config/configSurfaces.js";
import { getServerNamesFromConfig } from "../mcp/configGuards.js";
import { renameWithRetry } from "../utils/renameWithRetry.js";
import { normalizePolicy } from "../emit/normalizePolicy.js";
import { isPathContainedInAny } from "../utils/pathContainment.js";
import { restoreSecrets } from "../apply/applyConfig.js";
import { redactSecrets, sanitizeReport } from "../utils/redact.js";
import { makeUniqueTimestamp } from "../utils/timestamp.js";
import { parseJSON } from "../utils/json.js";
import {
  configsSemanticallyEqual,
  parseConfigFile,
  serializeJsonPreservingStyle,
} from "../utils/configFormat.js";
import { computeConfigContentHash } from "../mcp/configGuards.js";
import { CONFIG_BASELINE_CONFLICT_MESSAGE } from "./conflictMessages.js";
import { formatConfigLoadError } from "../config/formatConfigLoadError.js";
import { PreviewTokenStore, policyFingerprint } from "./previewTokenStore.js";
import { getOrCreatePersistedUiAuthToken } from "./uiAuthToken.js";
import { readAnalyzeHistory } from "../history/store.js";
import { formatHistoryJson } from "../history/formatHistory.js";
import { loadUserConfig } from "../state/userConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// SECURITY: Path-like fields that must be rejected in browser-supplied payloads
// Both preview and apply endpoints use this to prevent path injection
const FORBIDDEN_PATH_FIELDS = [
  "target",
  "file",
  "backupPath",
  "outDir",
  "path",
  "dir",
  "directory",
  "output",
  "outputDir",
  "exportDir",
  "configPath",
] as const;

// Per-target mutex for apply operations (prevents concurrent applies to same file)
const applyLocks = new Map<string, Promise<void>>();

/**
 * Acquire an exclusive lock for a target path.
 * Returns a release function that must be called to release the lock.
 */
async function acquireApplyLock(targetPath: string): Promise<() => void> {
  const normalizedPath = path.resolve(targetPath).toLowerCase();
  
  // Wait for any existing lock to release
  while (applyLocks.has(normalizedPath)) {
    await applyLocks.get(normalizedPath);
  }
  
  // Create new lock
  let releaseFn: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  applyLocks.set(normalizedPath, lockPromise);
  
  return () => {
    applyLocks.delete(normalizedPath);
    releaseFn!();
  };
}

/**
 * Readable timestamp with milliseconds and random suffix for uniqueness.
 * Format: 2026-09-25T04-45-12-123-82bd (Windows-safe, no colons)
 * Used for both exports AND backups for consistency.
 * Imported from shared utils/timestamp.ts.
 */
/**
 * Get all config directories that must be protected from export.
 * Returns directories of: all known client configs + the server's configPath (if provided).
 */
async function getForbiddenExportDirs(cwd: string, serverConfigPath?: string): Promise<string[]> {
  const dirs: string[] = [];
  
  // All known client config directories
  const clients = await detectClientConfigs(cwd);
  for (const client of clients) {
    dirs.push(path.dirname(client.path));
  }
  
  // Server's configPath directory (if provided and not already included)
  if (serverConfigPath) {
    const serverConfigDir = path.dirname(serverConfigPath);
    if (!dirs.includes(serverConfigDir)) {
      dirs.push(serverConfigDir);
    }
  }
  
  return dirs;
}

/**
 * Item 6: Validate Origin header for state-changing POSTs.
 * Accept ONLY the exact server origins: http://127.0.0.1:<port> and http://localhost:<port>.
 * Parse with new URL, never a prefix match.
 * Missing Origin is rejected for state-changing operations.
 */
function isValidOrigin(origin: string | undefined, allowedPort: number): boolean {
  if (!origin) {
    // Missing Origin on state-changing POST is rejected
    return false;
  }
  
  try {
    const parsed = new URL(origin);
    
    // Must be http (not https)
    if (parsed.protocol !== "http:") {
      return false;
    }
    
    // Hostname must be exactly 127.0.0.1 or localhost
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      return false;
    }
    
    // Port must match the server's actual port
    const originPort = parseInt(parsed.port) || 80;
    if (originPort !== allowedPort) {
      return false;
    }
    
    return true;
  } catch {
    // Invalid URL
    return false;
  }
}

/**
 * Compute SHA-256 hash of file content.
 */
async function computeFileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath, "utf8");
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

function serverNamesForConfig(config: unknown, configPath?: string): Set<string> {
  if (configPath) {
    return getServerNamesFromClientConfig(config, configPath);
  }
  return getServerNamesFromConfig(config);
}

async function getOriginalConfigForPolicy(config: ServerConfig): Promise<unknown | undefined> {
  if (config.configPath) {
    try {
      return parseClientConfigContent(
        await readFile(config.configPath, "utf8"),
        config.configPath
      );
    } catch {
      // fall through to cached copy
    }
  }
  return config.originalConfig;
}

function discoveryBusyResponse(config: ServerConfig, res: ServerResponse): boolean {
  if (config.isDiscoveryInProgress?.()) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Discovery in progress; retry preview/apply in a few seconds",
      })
    );
    return true;
  }
  return false;
}

function configUnreadableResponse(config: ServerConfig, res: ServerResponse): boolean {
  const err = config.getConfigLoadError?.();
  if (!err) {
    return false;
  }
  res.writeHead(503, { "Content-Type": "text/plain" });
  res.end(`Config file cannot be read: ${err}`);
  return true;
}

function respondConfigFileReadError(res: ServerResponse, err: unknown): void {
  res.writeHead(503, { "Content-Type": "text/plain" });
  res.end(`Config file cannot be read: ${formatConfigLoadError(err)}`);
}

function isUsableMcpConfigObject(
  originalConfig: unknown,
  configPath?: string
): boolean {
  if (originalConfig === null || typeof originalConfig !== "object" || Array.isArray(originalConfig)) {
    return false;
  }
  if (configPath) {
    return isRecognizedMcpConfigShape(originalConfig, configPath);
  }
  return true;
}

function buildProposedOpts(config: ServerConfig, report: Report) {
  return {
    report,
    discoveryInProgress: config.isDiscoveryInProgress?.() ?? false,
  };
}

/**
 * Create a simple before/after diff view of two JSON objects.
 * Returns a human-readable string showing the differences.
 */
function createDiff(before: unknown, after: unknown): string {
  const beforeStr = JSON.stringify(before, null, 2);
  const afterStr = JSON.stringify(after, null, 2);
  
  if (beforeStr === afterStr) {
    return "No changes.";
  }
  
  return `=== BEFORE ===\n${beforeStr}\n\n=== AFTER ===\n${afterStr}`;
}

export interface ServerConfig {
  port?: number;
  onReady: (url: string) => void;
  getReport: () => Report | null;
  configPath?: string;
  originalConfig?: unknown;
  cwd?: string;
  exportDir?: string; // Root directory for exports (server-controlled, never from browser)
  watchInterval?: number; // Server's polling interval in seconds (for GUI to respect)
  onWatchIntervalChange?: (intervalSec: number) => void; // Called when GUI changes interval
  reportSource?: 'tools-json' | 'config'; // Indicates if the report came from --tools-json (preview/apply unavailable)
  /** When true, preview/apply return 503 until discovery finishes. */
  isDiscoveryInProgress?: () => boolean;
  /** Override for tests; default 10MB. */
  maxRequestBodyBytes?: number;
  /** Raw config file content at last successful discovery (for apply baseline). */
  initialAnalyzedContent?: string;
  /** When set, MCP config on disk is unreadable; preview/apply are refused until fixed. */
  getConfigLoadError?: () => string | null;
  /** Default meter options from CLI (--model, --count-mode, etc.). */
  meterAnalyzeOpts?: AnalyzeOptions;
  /** Fixed auth token (tests); skips file persistence when set. */
  authToken?: string;
  /** Override directory for persisted UI auth tokens (tests). */
  uiAuthCacheDir?: string;
  /** When set (e.g. from `ui --client`), GUI preselects this client id. */
  defaultClientId?: string;
}

export interface ServerInstance {
  url: string;
  token: string;
  close: () => Promise<void>;
  broadcast: (snapshot: Snapshot, diff: Diff | null) => void;
  setWatchInterval: (intervalSec: number) => void;
  getWatchInterval: () => number;
  /** After poll re-discovery when on-disk config changed. */
  reconcileBaselineAfterPoll: (content: string, report: Report) => void;
}

interface AnalyzedBaseline {
  contentHash: string;
  serverNames: Set<string>;
  config: unknown;
}

interface SSEClient {
  res: ServerResponse;
  id: number;
}

export async function startServer(config: ServerConfig): Promise<ServerInstance> {
  // Item 3: Validate --export-dir at startup
  if (config.exportDir) {
    const cwd = config.cwd || process.cwd();
    const forbiddenDirs = await getForbiddenExportDirs(cwd, config.configPath);
    if (isPathContainedInAny(config.exportDir, forbiddenDirs)) {
      console.error(`ERROR: --export-dir cannot be inside a config directory`);
      console.error(`  Export dir: ${config.exportDir}`);
      console.error(`  Forbidden config directories:`);
      for (const dir of forbiddenDirs) {
        console.error(`    - ${dir}`);
      }
      process.exit(1);
    }
  }
  
  let token = "";
  const clients: SSEClient[] = [];
  let clientIdCounter = 0;
  let currentSnapshot: { snapshot: Snapshot; diff: Diff | null } | null = null;
  let broadcastCount = 0;
  let serverPort = 0; // Capture actual bound port for origin validation

  const maxRequestBodyBytes = config.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES;

  let analyzedOriginalConfig = config.originalConfig;
  let analyzedBaseline: AnalyzedBaseline | null = null;
  const previewTokenStore = new PreviewTokenStore();
  const cwdForClients = config.cwd || process.cwd();
  let cachedClientConfigs: ClientConfig[] = await detectClientConfigs(cwdForClients);

  async function refreshClientCacheIfHealthy(): Promise<void> {
    if (!config.getConfigLoadError?.()) {
      cachedClientConfigs = await detectClientConfigs(cwdForClients);
    }
  }

  async function resolveClientConfig(clientId: string): Promise<ClientConfig | null> {
    await refreshClientCacheIfHealthy();
    const fromCache = cachedClientConfigs.find((c) => c.id === clientId);
    if (fromCache) {
      return fromCache;
    }
    if (config.getConfigLoadError?.()) {
      return null;
    }
    const live = await getClientConfigById(clientId, cwdForClients);
    if (live) {
      cachedClientConfigs = await detectClientConfigs(cwdForClients);
    }
    return live;
  }

  function currentServerMetadata() {
    return {
      reportSource: config.reportSource || "config",
      configLoadError: config.getConfigLoadError?.() ?? null,
    };
  }

  function initAnalyzedBaseline(content: string, parsed: unknown, report: Report): void {
    const serverNames = new Set(report.servers?.map((s) => s.name) ?? []);
    for (const name of serverNamesForConfig(parsed, config.configPath)) {
      serverNames.add(name);
    }
    analyzedBaseline = {
      contentHash: computeConfigContentHash(content),
      serverNames,
      config: parsed,
    };
    analyzedOriginalConfig = parsed;
    report.sourceConfigHash = analyzedBaseline.contentHash;
  }

  function commitBaselineFromOurWrite(content: string, configFilePath?: string): void {
    const filePath = configFilePath ?? config.configPath ?? "mcp.json";
    const parsed = parseClientConfigContent(content, filePath);
    analyzedBaseline = {
      contentHash: computeConfigContentHash(content),
      serverNames: serverNamesForConfig(parsed, filePath),
      config: parsed,
    };
    analyzedOriginalConfig = parsed;
    const report = config.getReport();
    if (report) {
      report.sourceConfigHash = analyzedBaseline.contentHash;
    }
  }

  function reconcileBaselineAfterPoll(content: string, report: Report): void {
    const hash = computeConfigContentHash(content);
    if (analyzedBaseline && hash === analyzedBaseline.contentHash) {
      report.sourceConfigHash = hash;
      return;
    }
    const parsed = parseClientConfigContent(content, config.configPath ?? "mcp.json");
    const serverNames = new Set(report.servers?.map((s) => s.name) ?? []);
    for (const name of serverNamesForConfig(parsed, config.configPath)) {
      serverNames.add(name);
    }
    analyzedBaseline = { contentHash: hash, serverNames, config: parsed };
    analyzedOriginalConfig = parsed;
    report.sourceConfigHash = hash;
  }

  function assertAnalyzedBaselineMatches(content: string, targetConfig: unknown): boolean {
    if (!analyzedBaseline) {
      return true;
    }
    const hash = computeConfigContentHash(content);
    if (hash !== analyzedBaseline.contentHash) {
      return false;
    }
    const targetServers = serverNamesForConfig(targetConfig, config.configPath);
    if (targetServers.size !== analyzedBaseline.serverNames.size) {
      return false;
    }
    for (const name of analyzedBaseline.serverNames) {
      if (!targetServers.has(name)) {
        return false;
      }
    }
    return true;
  }

  if (config.initialAnalyzedContent && config.originalConfig) {
    const report = config.getReport();
    if (report) {
      initAnalyzedBaseline(
        config.initialAnalyzedContent,
        config.originalConfig,
        report
      );
    }
  }

  const server = createServer(async (req, res) => {
    try {
      // CORS: no permissive headers
      const host = req.headers.host || "";
      
      // Exact host:port validation - must match 127.0.0.1:<port> or localhost:<port>
      // Not just prefix check to prevent attacks like "localhost:evil.example"
      const hostRegex = /^(127\.0\.0\.1|localhost):\d+$/;
      if (!hostRegex.test(host)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden: invalid Host header" }));
        return;
      }

      // Parse URL from fixed base to avoid ERR_INVALID_URL from malicious Host
      let url: URL;
      try {
        url = new URL(req.url || "/", "http://127.0.0.1");
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad Request: malformed URL" }));
        return;
      }
    
    // Token auth (not required for static assets, only for API)
    if (url.pathname.startsWith("/api/")) {
      const authHeader = req.headers.authorization || req.headers["x-auth-token"] || "";
      const authString = Array.isArray(authHeader) ? authHeader[0] || "" : authHeader;
      const providedToken = authString.replace(/^Bearer\s+/i, "");
      if (providedToken !== token) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }
    
    if (url.pathname === "/api/health") {
      const configLoadError = config.getConfigLoadError?.() ?? null;
      const apiFlags = apiConfiguredFlags();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ 
        status: configLoadError ? "degraded" : "ok", 
        timestamp: new Date().toISOString(),
        watchIntervalSec: config.watchInterval || 30,
        configLoadError,
        countMode: config.meterAnalyzeOpts?.countMode ?? "offline",
        defaultClientId: config.defaultClientId ?? null,
        optionalApis: {
          anthropic: apiFlags.anthropic,
          gemini: apiFlags.gemini,
        },
      }));
      return;
    }

    if (url.pathname === "/api/analyze-history") {
      const { file, corrupt } = await readAnalyzeHistory();
      const payload = formatHistoryJson(file.entries, {});
      let budget: { total?: number; clients?: Record<string, number> } | undefined;
      try {
        const { config } = await loadUserConfig();
        if (config.budget) {
          budget = {
            total: config.budget.total,
            clients: config.budget.clients,
          };
        }
      } catch {
        // omit budget overlay when user config is invalid
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ...payload,
          corrupt,
          budget,
        })
      );
      return;
    }

    if (url.pathname === "/api/model-presets") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          models: listPresetModelsForUi().map((m) => ({
            id: m.id,
            family: m.family,
            framing: m.framing,
            offlineSource: m.offlineSource,
            experimental: isExperimentalModelId(m.id),
          })),
        })
      );
      return;
    }

    if (url.pathname === "/api/model-counts" && req.method === "POST") {
      if (!isValidOrigin(req.headers.origin, serverPort)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: invalid Origin");
        return;
      }
      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("application/json")) {
        res.writeHead(415, { "Content-Type": "text/plain" });
        res.end("Unsupported Media Type: expected application/json");
        return;
      }
      const body = await readBody(req, res, maxRequestBodyBytes);
      if (body === null) {
        return;
      }
      let payload: {
        modelIds?: unknown;
        primaryModelId?: string;
        countMode?: "offline" | "api" | "auto";
      };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: invalid JSON");
        return;
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "body must be a JSON object" }));
        return;
      }
      const apiValidated = validateModelCountsApiPayload(payload);
      if (!apiValidated.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: apiValidated.error }));
        return;
      }
      const validated = validateModelIdsPayload(payload.modelIds);
      if (!validated.ok) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: validated.error }));
        return;
      }
      const tools: Tool[] = currentSnapshot?.snapshot.tools ?? [];
      const servers = currentSnapshot?.snapshot.servers ?? [];
      if (tools.length === 0) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Tools not yet available" }));
        return;
      }
      const merged: AnalyzeOptions = {
        ...(config.meterAnalyzeOpts ?? {}),
        primaryModelId: payload.primaryModelId ?? config.meterAnalyzeOpts?.primaryModelId,
        modelIds: validated.modelIds,
        countMode: payload.countMode ?? config.meterAnalyzeOpts?.countMode ?? "offline",
      };
      try {
        const report = await analyzeToolsAsync(tools, servers, merged);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            tokenCountsByModel: report.tokenCountsByModel ?? {},
            tools: report.tools.map((t) => ({
              server: t.server,
              name: t.name,
              countsByModel: t.countsByModel ?? {},
            })),
          })
        );
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Model count failed" }));
      }
      return;
    }

    if (url.pathname === "/api/report") {
      const report = config.getReport();
      if (!report) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Report not yet available" }));
        return;
      }
      
      // Redact secrets in servers
      const sanitized = sanitizeReport(report);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        report: sanitized,
        serverMetadata: currentServerMetadata(),
      }));
      return;
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      
      const client: SSEClient = { res, id: clientIdCounter++ };
      clients.push(client);

      // Send current snapshot immediately on connect
      if (currentSnapshot) {
        try {
          const sanitized = sanitizeReport(currentSnapshot.snapshot.report);
          const event = {
            type: "initial",
            snapshot: {
              timestamp: currentSnapshot.snapshot.timestamp,
              report: sanitized,
            },
            serverMetadata: currentServerMetadata(),
          };
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Client may have disconnected
        }
      }

      req.on("close", () => {
        const idx = clients.indexOf(client);
        if (idx >= 0) clients.splice(idx, 1);
      });
      return;
    }

    // Stage B endpoints
    if (url.pathname === "/api/clients") {
      await refreshClientCacheIfHealthy();
      const sanitized = cachedClientConfigs.map(c => ({
        id: c.id,
        name: c.name,
        profile: c.profile,
        viewOnly: c.viewOnly,
        // Never send the actual path to the browser
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clients: sanitized }));
      return;
    }

    if (url.pathname === "/api/proposal" && req.method === "POST") {
      // Security checks for POST (Item 6)
      if (!isValidOrigin(req.headers.origin, serverPort)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: invalid Origin");
        return;
      }

      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("application/json")) {
        res.writeHead(415, { "Content-Type": "text/plain" });
        res.end("Unsupported Media Type: expected application/json");
        return;
      }

      const body = await readBody(req, res, maxRequestBodyBytes);
      if (body === null) {
        return;
      }
      let payload: { policy: PolicyOptions; clientId?: string };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: invalid JSON");
        return;
      }

      // Get report (use current if no clientId)
      const report = config.getReport();
      if (!report) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Report not yet available" }));
        return;
      }

      // Normalize policy with CLI defaults (keepPerServer: 2, no server removal)
      const normalizedPolicy = normalizePolicy(payload.policy);

      // Apply policy and generate proposal
      const result = selectHotToolsWithPolicy(report.tools, normalizedPolicy);
      const savings = calculateSavings(report.tools, result.hot, result.disabledServers);
      
      // Build proposals
      const keepProposal = buildKeepProposal(report.tools, result.hot);
      const deferHints = buildDeferHints(report.tools, result.hot);
      
      const originalForPolicy = await getOriginalConfigForPolicy(config);

      // Build proposed config if we have original
      let proposedConfig = null;
      let allRemovedServers: string[] = [];
      if (originalForPolicy) {
        const proposed = config.configPath
          ? buildClientProposedMcpConfig(
              config.configPath,
              originalForPolicy,
              result.hot,
              result.disabledServers,
              report.tools,
              buildProposedOpts(config, report)
            )
          : buildProposedMcpConfig(
              originalForPolicy,
              result.hot,
              result.disabledServers,
              report.tools,
              buildProposedOpts(config, report)
            );
        // Redact secrets before returning
        proposedConfig = redactSecrets(proposed.proposed);
        allRemovedServers = Array.from(proposed.allRemovedServers).sort();
      }
      
      // Fix savings to use correct removed server count (including zero-tool servers)
      const correctedSavings = {
        ...savings,
        removedServersCount: allRemovedServers.length,
        removedServers: allRemovedServers,
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        savings: correctedSavings,
        keepProposal,
        deferHints,
        proposedConfig,
        removedServers: allRemovedServers,
        hasZeroKeptWarning: allRemovedServers.length > 0,
      }));
      return;
    }

    if (url.pathname === "/api/export" && req.method === "POST") {
      // Security checks for POST (Item 6)
      if (!isValidOrigin(req.headers.origin, serverPort)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: invalid Origin");
        return;
      }

      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("application/json")) {
        res.writeHead(415, { "Content-Type": "text/plain" });
        res.end("Unsupported Media Type: expected application/json");
        return;
      }

      const body = await readBody(req, res, maxRequestBodyBytes);
      if (body === null) {
        return;
      }
      let payload: { policy: PolicyOptions; clientId: string; [key: string]: unknown };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: invalid JSON");
        return;
      }

      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: body must be a JSON object");
        return;
      }

      // SECURITY: Reject any browser-supplied paths
      // Never accept outDir, path, dir, directory, output, or any path-like field
      const pathLikeFields = ["outDir", "path", "dir", "directory", "output", "outputDir", "exportDir"];
      for (const field of pathLikeFields) {
        if (field in payload) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`Bad Request: '${field}' field not allowed (server controls export location)`);
          return;
        }
      }

      // Validate clientId (reject browser-supplied paths)
      if (!payload.clientId) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: clientId required");
        return;
      }

      const cwd = config.cwd || process.cwd();

      if (configUnreadableResponse(config, res)) {
        return;
      }

      const client = await resolveClientConfig(payload.clientId);
      if (!client) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found: unknown client ID");
        return;
      }

      // Reject export for view-only clients
      if (client.viewOnly) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: client is view-only (no emit profile)");
        return;
      }

      // Get report
      const report = config.getReport();
      if (!report) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Report not yet available" }));
        return;
      }

      let originalConfig: unknown;
      try {
        const configContent = await readFile(client.path, "utf8");
        originalConfig = parseClientConfigContent(configContent, client.path);
      } catch (err) {
        respondConfigFileReadError(res, err);
        return;
      }

      if (!isUsableMcpConfigObject(originalConfig, client.path)) {
        res.writeHead(422, { "Content-Type": "text/plain" });
        res.end("Cannot export: MCP config is missing or invalid");
        return;
      }

      // Determine output directory (server-controlled, never from browser)
      // Default: <cwd>/tool-token-budget-export/<timestamp>/
      // Can only be overridden via --export-dir server flag
      const exportRoot = config.exportDir || defaultExportDirForCwd(cwd);
      const timestamp = makeUniqueTimestamp();
      const outDir = path.join(exportRoot, timestamp);
      const resolvedOutDir = path.resolve(outDir);
      
      // SECURITY GUARD: Never write into ANY config directory
      // Check ALL client config directories + server's configPath directory
      const forbiddenDirs = await getForbiddenExportDirs(cwd, config.configPath);
      if (isPathContainedInAny(resolvedOutDir, forbiddenDirs)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: export directory cannot be inside any config directory");
        return;
      }
      
      // Apply policy and generate artifacts
      // Normalize policy with CLI defaults (keepPerServer: 2, no server removal)
      const normalizedPolicy = normalizePolicy(payload.policy);
      const result = selectHotToolsWithPolicy(report.tools, normalizedPolicy);
      const savings = calculateSavings(report.tools, result.hot, result.disabledServers);
      
      // Build proposed config to check for zero servers
      const proposed = buildClientProposedMcpConfig(
        client.path,
        originalConfig,
        result.hot,
        result.disabledServers,
        report.tools,
        buildProposedOpts(config, report)
      );
      
      const proposedServerNames = serverNamesForConfig(proposed.proposed, client.path);
      const totalServers = serverNamesForConfig(originalConfig, client.path).size;
      if (totalServers > 0 && proposedServerNames.size === 0) {
        res.writeHead(422, { "Content-Type": "text/plain" });
        res.end("Cannot export: proposal removes all servers (zero servers kept)");
        return;
      }
      
      // Write artifacts
      // Create export directory with exclusive mkdir (retry on collision)
      let finalOutDir = resolvedOutDir;
      let retries = 0;
      const maxRetries = 10;
      while (retries < maxRetries) {
        try {
          // Create parent with recursive, but final segment without (exclusive)
          const parent = path.dirname(finalOutDir);
          await mkdir(parent, { recursive: true });
          await mkdir(finalOutDir, { recursive: false });
          break; // Success
        } catch (err: any) {
          if (err.code === "EEXIST" && retries < maxRetries - 1) {
            // Collision; generate new timestamp and retry
            const newTimestamp = makeUniqueTimestamp();
            finalOutDir = path.join(exportRoot, newTimestamp);
            retries++;
            continue;
          }
          throw err; // Give up or different error
        }
      }
      
      const written: string[] = [];
      
      // Write report.json (sanitize secrets before writing)
      const reportWithSavings = { ...report, savings };
      const sanitizedReport = sanitizeReport(reportWithSavings);
      const reportPath = path.join(finalOutDir, "report.json");
      await writeFile(reportPath, JSON.stringify(sanitizedReport, null, 2) + "\n", "utf8");
      written.push(reportPath);
      
      // Write keep proposal
      const keepProposalPath = keepProposalWritePath(finalOutDir);
      await writeFile(
        keepProposalPath,
        JSON.stringify(buildKeepProposal(report.tools, result.hot), null, 2) + "\n",
        "utf8"
      );
      written.push(keepProposalPath);
      
      // Write defer hints (always, for CLI parity)
      const deferPath = path.join(finalOutDir, "defer-hints.json");
      await writeFile(
        deferPath,
        JSON.stringify(buildDeferHints(report.tools, result.hot), null, 2) + "\n",
        "utf8"
      );
      written.push(deferPath);
      
      // Write proposed config (never overwrite mcp.json)
      const proposedName = proposedExportFilenameForClient(client);
      const proposedPath = path.join(finalOutDir, proposedName);
      // proposed.proposed is redacted per-server in buildProposedMcpConfig (remote passthrough included)
      await writeFile(
        proposedPath,
        JSON.stringify(proposed.proposed, null, 2) + "\n",
        "utf8"
      );
      written.push(proposedPath);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        written: written.map(p => path.relative(cwd, p)),
        exportDir: finalOutDir,
      }));
      return;
    }

    if (url.pathname === "/api/watch-interval" && req.method === "POST") {
      // Security checks for POST (Item 6)
      if (!isValidOrigin(req.headers.origin, serverPort)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: invalid Origin");
        return;
      }

      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("application/json")) {
        res.writeHead(415, { "Content-Type": "text/plain" });
        res.end("Unsupported Media Type: expected application/json");
        return;
      }

      const body = await readBody(req, res, maxRequestBodyBytes);
      if (body === null) {
        return;
      }
      let payload: { intervalSec: number };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: invalid JSON");
        return;
      }

      // Validate interval (Item 8: must be integer, 10s minimum, 3600s maximum)
      const intervalSec = payload.intervalSec;
      
      // Reject non-numbers, strings, and non-integers
      if (typeof intervalSec !== "number" || !Number.isInteger(intervalSec)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          error: "Interval must be an integer",
        }));
        return;
      }
      
      if (intervalSec < 10 || intervalSec > 3600) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          error: "Interval must be between 10 and 3600 seconds",
          min: 10,
          max: 3600
        }));
        return;
      }

      // Update the watch interval via callback
      if (config.onWatchIntervalChange) {
        config.onWatchIntervalChange(intervalSec);
        config.watchInterval = intervalSec;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ 
        success: true,
        intervalSec: config.watchInterval || intervalSec
      }));
      return;
    }

    // Stage C: POST /api/apply/preview
    if (url.pathname === "/api/apply/preview" && req.method === "POST") {
      // Security checks for POST
      if (!isValidOrigin(req.headers.origin, serverPort)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: invalid Origin");
        return;
      }

      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("application/json")) {
        res.writeHead(415, { "Content-Type": "text/plain" });
        res.end("Unsupported Media Type: expected application/json");
        return;
      }

      const body = await readBody(req, res, maxRequestBodyBytes);
      if (body === null) {
        return;
      }
      let payload: { policy: PolicyOptions; clientId: string; [key: string]: unknown };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: invalid JSON");
        return;
      }

      // Validate payload is an object
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: body must be a JSON object");
        return;
      }

      // SECURITY: Reject any browser-supplied paths (same as export and apply)
      for (const field of FORBIDDEN_PATH_FIELDS) {
        if (field in payload) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`Bad Request: '${field}' field not allowed (server controls paths)`);
          return;
        }
      }

      // Validate clientId
      if (!payload.clientId) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: clientId required");
        return;
      }

      const cwd = config.cwd || process.cwd();
      
      // Refuse preview/apply under --tools-json (target isn't what was measured)
      // This check happens BEFORE client validation
      if (config.reportSource === 'tools-json') {
        res.writeHead(422, { "Content-Type": "text/plain" });
        res.end("Apply not available: server started with --tools-json (target config not analyzed)");
        return;
      }

      const client = await resolveClientConfig(payload.clientId);
      if (!client) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found: unknown client ID");
        return;
      }

      if (configUnreadableResponse(config, res)) {
        return;
      }

      // Reject for view-only clients
      if (client.viewOnly) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: client is view-only (no apply profile)");
        return;
      }

      // Get report
      const report = config.getReport();
      if (!report) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Report not yet available" }));
        return;
      }

      if (discoveryBusyResponse(config, res)) {
        return;
      }

      // Read original config (the actual target file)
      let originalConfig: unknown;
      let configContent = "";
      try {
        configContent = await readFile(client.path, "utf8");
        originalConfig = parseClientConfigContent(configContent, client.path);
      } catch (err) {
        respondConfigFileReadError(res, err);
        return;
      }

      if (!isUsableMcpConfigObject(originalConfig, client.path)) {
        res.writeHead(422, { "Content-Type": "text/plain" });
        res.end("Config file cannot be read: MCP config is missing or invalid");
        return;
      }

      if (!assertAnalyzedBaselineMatches(configContent, originalConfig)) {
        res.writeHead(409, { "Content-Type": "text/plain" });
        res.end(CONFIG_BASELINE_CONFLICT_MESSAGE);
        return;
      }

      // Generate proposed config
      const normalizedPolicy = normalizePolicy(payload.policy);
      const result = selectHotToolsWithPolicy(report.tools, normalizedPolicy);
      const proposed = buildClientProposedMcpConfig(
        client.path,
        originalConfig,
        result.hot,
        result.disabledServers,
        report.tools,
        buildProposedOpts(config, report)
      );

      const targetServers = serverNamesForConfig(originalConfig, client.path);
      if (targetServers.size === 0) {
        res.writeHead(422, { "Content-Type": "text/plain" });
        res.end("Unprocessable: no servers in config");
        return;
      }
      // Refuse if result would leave zero servers
      const proposedServers = serverNamesForConfig(proposed.proposed, client.path);
      if (proposedServers.size === 0) {
        res.writeHead(422, { "Content-Type": "text/plain" });
        res.end("Unprocessable: policy would remove all servers. Adjust keep settings.");
        return;
      }

      // Refuse if removes servers the policy doesn't call for
      const removedServers = [...targetServers].filter(s => !proposedServers.has(s));
      const expectedRemovals = proposed.allRemovedServers;
      const unexpectedRemovals = removedServers.filter(s => !expectedRemovals.has(s));
      if (unexpectedRemovals.length > 0) {
        res.writeHead(422, { "Content-Type": "text/plain" });
        res.end(`Unprocessable: would unexpectedly remove servers: ${unexpectedRemovals.join(", ")}`);
        return;
      }

      // Compute hash of current file
      const currentHash = await computeFileHash(client.path);

      // Redact secrets in BOTH before and after for diff and response
      const redactedOriginal = redactSecrets(originalConfig);
      const redactedProposed = redactSecrets(proposed.proposed);
      const diff = createDiff(redactedOriginal, redactedProposed);

      const baselineHash = analyzedBaseline?.contentHash ?? currentHash;
      const previewToken = previewTokenStore.issue({
        targetPath: client.path,
        contentHash: currentHash,
        clientId: payload.clientId,
        policyHash: policyFingerprint(normalizedPolicy),
        baselineHash,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        diff,
        currentHash,
        previewToken,
        // Never return raw configs - always redacted
        originalConfig: redactedOriginal,
        proposedConfig: redactedProposed,
      }));
      return;
    }

    // Stage C: POST /api/apply
    if (url.pathname === "/api/apply" && req.method === "POST") {
      // Security checks for POST
      if (!isValidOrigin(req.headers.origin, serverPort)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: invalid Origin");
        return;
      }

      const contentType = req.headers["content-type"] || "";
      if (!contentType.includes("application/json")) {
        res.writeHead(415, { "Content-Type": "text/plain" });
        res.end("Unsupported Media Type: expected application/json");
        return;
      }

      const body = await readBody(req, res, maxRequestBodyBytes);
      if (body === null) {
        return;
      }
      let payload: { 
        policy: PolicyOptions; 
        clientId: string; 
        previewHash: string;
        previewToken: string;
        confirmation: string;
        [key: string]: unknown;
      };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: invalid JSON");
        return;
      }

      // Validate payload is an object
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: body must be a JSON object");
        return;
      }

      // SECURITY: Reject any browser-supplied paths
      for (const field of FORBIDDEN_PATH_FIELDS) {
        if (field in payload) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`Bad Request: '${field}' field not allowed (server controls paths)`);
          return;
        }
      }

      // Also reject any unexpected field that looks like a path
      for (const [key, value] of Object.entries(payload)) {
        if (
          key !== "policy" &&
          key !== "clientId" &&
          key !== "previewHash" &&
          key !== "previewToken" &&
          key !== "confirmation" &&
          typeof value === "string"
        ) {
          // Check if value looks like a path
          if (value.includes("/") || value.includes("\\") || value.includes("..")) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end(`Bad Request: unexpected path-like field '${key}' not allowed`);
            return;
          }
        }
      }

      // Validate confirmation field
      if (payload.confirmation !== "apply") {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: confirmation must be exactly 'apply'");
        return;
      }

      // Validate clientId
      if (!payload.clientId) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: clientId required");
        return;
      }

      // Validate previewHash
      if (!payload.previewHash) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: previewHash required");
        return;
      }

      const cwd = config.cwd || process.cwd();
      
      // Refuse preview/apply under --tools-json
      if (config.reportSource === 'tools-json') {
        res.writeHead(422, { "Content-Type": "text/plain" });
        res.end("Apply not available: server started with --tools-json (target config not analyzed)");
        return;
      }

      const client = await resolveClientConfig(payload.clientId);
      if (!client) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found: unknown client ID");
        return;
      }

      // Reject for view-only clients
      if (client.viewOnly) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: client is view-only (no apply profile)");
        return;
      }

      if (!payload.previewToken || typeof payload.previewToken !== "string") {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad Request: previewToken required");
        return;
      }

      // Get report
      const report = config.getReport();
      if (!report) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Report not yet available" }));
        return;
      }

      if (discoveryBusyResponse(config, res)) {
        return;
      }
      if (configUnreadableResponse(config, res)) {
        return;
      }

      // ACQUIRE LOCK for this target file (serializes concurrent applies)
      const releaseLock = await acquireApplyLock(client.path);
      
      try {
        // Re-verify hash INSIDE the lock (double-check after waiting for lock)
        const currentHash = await computeFileHash(client.path);
        if (currentHash !== payload.previewHash) {
          res.writeHead(409, { "Content-Type": "text/plain" });
          res.end("Conflict: config file has changed since preview. Please re-preview.");
          return;
        }

        // Read original config
        let originalConfig: unknown;
        try {
          const configContent = await readFile(client.path, "utf8");
          originalConfig = parseClientConfigContent(configContent, client.path);
        } catch (err) {
          respondConfigFileReadError(res, err);
          return;
        }

        const applyContent = await readFile(client.path, "utf8");
        if (!assertAnalyzedBaselineMatches(applyContent, originalConfig)) {
          res.writeHead(409, { "Content-Type": "text/plain" });
          res.end(CONFIG_BASELINE_CONFLICT_MESSAGE);
          return;
        }

        const issued = previewTokenStore.get(payload.previewToken);
        if (!issued) {
          res.writeHead(409, { "Content-Type": "text/plain" });
          res.end("Conflict: invalid or expired preview token. Please preview again.");
          return;
        }
        if (issued.clientId !== payload.clientId) {
          res.writeHead(409, { "Content-Type": "text/plain" });
          res.end("Conflict: preview token was issued for a different client. Please preview again.");
          return;
        }
        if (issued.targetPath !== client.path) {
          res.writeHead(409, { "Content-Type": "text/plain" });
          res.end("Conflict: invalid or expired preview token. Please preview again.");
          return;
        }
        const applyPolicyHash = policyFingerprint(payload.policy);
        if (issued.policyHash !== applyPolicyHash) {
          res.writeHead(409, { "Content-Type": "text/plain" });
          res.end("Conflict: preview token does not match this policy. Please preview again.");
          return;
        }
        const currentBaseline = analyzedBaseline?.contentHash;
        if (currentBaseline && issued.baselineHash !== currentBaseline) {
          res.writeHead(409, { "Content-Type": "text/plain" });
          res.end("Conflict: preview token does not match analyzed config baseline. Please preview again.");
          return;
        }
        if (issued.contentHash !== payload.previewHash) {
          res.writeHead(409, { "Content-Type": "text/plain" });
          res.end("Conflict: preview token does not match this preview. Please preview again.");
          return;
        }
        if (previewTokenStore.isConsumed(payload.previewToken)) {
          res.writeHead(409, { "Content-Type": "text/plain" });
          res.end("Conflict: this preview was already applied. Please preview again.");
          return;
        }

        // Generate proposed config
        const normalizedPolicy = normalizePolicy(payload.policy);
        const result = selectHotToolsWithPolicy(report.tools, normalizedPolicy);
        const proposed = buildClientProposedMcpConfig(
          client.path,
          originalConfig,
          result.hot,
          result.disabledServers,
          report.tools,
          buildProposedOpts(config, report)
        );

        const targetServers = serverNamesForConfig(originalConfig, client.path);
        if (targetServers.size === 0) {
          res.writeHead(422, { "Content-Type": "text/plain" });
          res.end("Unprocessable: no servers in config");
          return;
        }
        // Refuse if result would leave zero servers
        const proposedServers = serverNamesForConfig(proposed.proposed, client.path);
        if (proposedServers.size === 0) {
          res.writeHead(422, { "Content-Type": "text/plain" });
          res.end("Unprocessable: policy would remove all servers. Adjust keep settings.");
          return;
        }

        // Refuse if removes servers the policy doesn't call for
        const removedServers = [...targetServers].filter(s => !proposedServers.has(s));
        const expectedRemovals = proposed.allRemovedServers;
        const unexpectedRemovals = removedServers.filter(s => !expectedRemovals.has(s));
        if (unexpectedRemovals.length > 0) {
          res.writeHead(422, { "Content-Type": "text/plain" });
          res.end(`Unprocessable: would unexpectedly remove servers: ${unexpectedRemovals.join(", ")}`);
          return;
        }

        // Restore secrets from original config
        const { result: restoredConfig, errors } = restoreSecrets(proposed.proposed, originalConfig);
        if (errors.length > 0) {
          res.writeHead(422, { "Content-Type": "text/plain" });
          res.end(`Cannot restore secrets: ${errors.join("; ")}. Apply refused.`);
          return;
        }

        // Verify no placeholders remain in the restored config
        const configStr = JSON.stringify(restoredConfig);
        if (configStr.includes("<from-original>") || configStr.includes("<redacted>")) {
          res.writeHead(422, { "Content-Type": "text/plain" });
          res.end("Cannot restore secrets: placeholders remain in config after rehydration. Apply refused.");
          return;
        }

        const currentContent = await readFile(client.path, "utf8");
        const currentParsed = parseClientConfigContent(currentContent, client.path);
        if (configsSemanticallyEqual(restoredConfig, currentParsed)) {
          commitBaselineFromOurWrite(currentContent, client.path);
          previewTokenStore.markConsumed(payload.previewToken);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, noOp: true }));
          return;
        }

        // Create timestamped backup with EXCLUSIVE flag (retry on collision)
        const timestamp = makeUniqueTimestamp();
        let backupPath = `${client.path}.bak-${timestamp}`;
        let backupRetries = 0;
        const maxBackupRetries = 10;
        
        while (backupRetries < maxBackupRetries) {
          try {
            // Try exclusive copy (fails if backup already exists)
            const originalContent = await readFile(client.path, "utf8");
            const backupFd = await open(backupPath, "wx"); // Exclusive write
            await backupFd.writeFile(originalContent, "utf8");
            await backupFd.close();
            break; // Success
          } catch (err: any) {
            if (err.code === "EEXIST" && backupRetries < maxBackupRetries - 1) {
              // Collision, generate new timestamp and retry
              const newTimestamp = makeUniqueTimestamp();
              backupPath = `${client.path}.bak-${newTimestamp}`;
              backupRetries++;
              continue;
            }
            // Give up or different error
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(`Failed to create backup: ${err.message || String(err)}`);
            return;
          }
        }

        // Atomic write: write to temp file then rename
        const surface = getConfigSurface(client.path, currentParsed);
        const serialized = surface.serializeMerged(currentContent, restoredConfig);
        const tempPath = `${client.path}.tmp-${timestamp}`;
        try {
          await writeFile(tempPath, serialized, "utf8");
          await renameWithRetry(tempPath, client.path);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`Failed to write config: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }

        const writtenContent = await readFile(client.path, "utf8");
        commitBaselineFromOurWrite(writtenContent, client.path);
        previewTokenStore.markConsumed(payload.previewToken);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          backupPath,
          message: "Config applied successfully",
        }));
      } finally {
        // Always release the lock
        releaseLock();
      }
      return;
    }

    // Unknown /api/* paths must return 404 JSON, not fall through to SPA
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
      return;
    }

    // Serve GUI assets
    if (req.method === "GET") {
      await serveStatic(url.pathname, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    } catch (err) {
      // Top-level try/catch: server must never crash from a request
      const errMsg = err instanceof Error ? err.message : String(err);
      const redactedMsg = redactSecrets(errMsg);
      console.error("Request handler error:", redactedMsg);
      try {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      } catch {
        // Response already sent or client disconnected
      }
    }
  });

  const port = config.port || 0;
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Server failed to bind");
  }

  const actualPort = addr.port;
  serverPort = actualPort; // Capture for origin validation
  token = getOrCreatePersistedUiAuthToken(
    actualPort,
    config.authToken,
    config.uiAuthCacheDir
  );
  const url = `http://127.0.0.1:${actualPort}?token=${token}`;
  config.onReady(url);

  return {
    url,
    token,
    close: async () => {
      for (const client of clients) {
        client.res.end();
      }
      clients.length = 0;
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    broadcast: (snapshot: Snapshot, diff: Diff | null) => {
      // Store current snapshot for new clients
      currentSnapshot = { snapshot, diff };
      broadcastCount++;
      
      const sanitized = sanitizeReport(snapshot.report);
      const event = {
        // First broadcast is initial, all subsequent polls are updates (even if no change)
        type: broadcastCount === 1 ? "initial" : "update",
        snapshot: {
          timestamp: snapshot.timestamp,
          report: sanitized,
        },
        serverMetadata: currentServerMetadata(),
        diff: diff ? serializeDiff(diff) : { servers: { added: [], removed: [], statusChanged: [] }, tools: { added: [], removed: [], changed: [] }, tokens: { total: 0, perServer: {} } },
      };
      const data = JSON.stringify(event);
      for (const client of clients) {
        try {
          client.res.write(`data: ${data}\n\n`);
        } catch {
          // Client disconnected
        }
      }
    },
    setWatchInterval: (intervalSec: number) => {
      config.watchInterval = intervalSec;
    },
    getWatchInterval: () => {
      return config.watchInterval || 30;
    },
    reconcileBaselineAfterPoll: (content: string, report: Report) => {
      reconcileBaselineAfterPoll(content, report);
    },
  };
}

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (!tooLarge && body.length > maxBytes) {
        tooLarge = true;
        req.pause();
        res.writeHead(413, { "Content-Type": "text/plain" });
        res.end("Payload Too Large");
        resolve(null);
      }
    });
    req.on("end", () => {
      if (!tooLarge) {
        resolve(body);
      }
    });
    req.on("error", reject);
  });
}

function serializeDiff(diff: Diff) {
  return {
    servers: diff.servers,
    tools: diff.tools,
    tokens: {
      total: diff.tokens.total,
      perServer: Object.fromEntries(diff.tokens.perServer),
    },
  };
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  // Map paths to GUI dist
  const guiRoot = path.resolve(__dirname, "..", "..", "dist", "gui");
  
  let filePath: string;
  if (pathname === "/" || pathname === "/index.html") {
    filePath = path.join(guiRoot, "index.html");
  } else {
    filePath = path.join(guiRoot, pathname);
  }

  // Security: ensure path is within guiRoot
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(guiRoot)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(resolved);
    const ext = path.extname(resolved);
    const contentType = getContentType(ext);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    // Try index.html for SPA routing
    if (pathname !== "/" && pathname !== "/index.html") {
      try {
        const indexPath = path.join(guiRoot, "index.html");
        const content = await readFile(indexPath);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(content);
        return;
      } catch {
        // Fall through to 404
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  return types[ext] || "application/octet-stream";
}
