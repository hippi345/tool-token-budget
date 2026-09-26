import { access, constants, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  ALL_CLIENT_CONFIG_IDS,
  type ClientConfig,
  type DetectClientConfigDeps,
  detectClientConfigs,
  getAppDataDirFor,
  getClientConfigById,
  getCodexHome,
  normalizeClientConfigId,
  resolveDetectClientConfigDeps,
} from "../discover/clientConfigs.js";
import {
  getConfigSurface,
  inferConfigSurfaceKind,
  mergeProposedOntoClientConfig,
  parseClientConfigContent,
} from "../config/configSurfaces.js";
import { formatConfigLoadError } from "../config/formatConfigLoadError.js";
import { isCodexTomlConfigFile } from "../config/codexToml.js";
import { withApplyFileLock, ApplyLockError } from "../apply/applyLock.js";
import { renameWithRetry } from "../utils/renameWithRetry.js";
import { makeUniqueTimestamp } from "../utils/timestamp.js";
import { configsSemanticallyEqual } from "../utils/configFormat.js";
import {
  canonicalizeServerEntry,
  capabilitiesForSurfaceKind,
  logicalEntriesEqual,
  translateCanonicalToTargetLogical,
  type CanonicalMcpServer,
} from "./syncClientCapabilities.js";

export interface SyncMcpClientsOptions {
  fromClientId: string;
  toClientId: string | "all";
  cwd?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  confirm?: (prompt: string) => Promise<boolean>;
  detectDeps?: Partial<DetectClientConfigDeps>;
}

export interface SyncTargetPlan {
  clientId: string;
  clientName: string;
  configPath: string;
  added: string[];
  changed: string[];
  removed: string[];
  skippedServers: Array<{ name: string; reason: string }>;
  noOp: boolean;
  written: boolean;
  /** Target config file did not exist before sync (create on apply). */
  created?: boolean;
  backupPath?: string;
}

export interface SyncSkippedClient {
  clientId: string;
  reason: string;
}

export interface SyncMcpClientsResult {
  sourceClientId: string;
  sourceConfigPath: string;
  dryRun: boolean;
  applied: boolean;
  cancelled: boolean;
  skippedClients: SyncSkippedClient[];
  targets: SyncTargetPlan[];
  warnings: string[];
}

export const SYNC_ERROR_CODES = {
  UNKNOWN_CLIENT: "SYNC_UNKNOWN_CLIENT",
  SOURCE_EQUALS_TARGET: "SYNC_SOURCE_EQUALS_TARGET",
  VIEW_ONLY_SOURCE: "SYNC_VIEW_ONLY_SOURCE",
  VIEW_ONLY_TARGET: "SYNC_VIEW_ONLY_TARGET",
  MISSING_SOURCE: "SYNC_MISSING_SOURCE",
  SOURCE_READ_FAILED: "SYNC_SOURCE_READ_FAILED",
  TARGET_READ_FAILED: "SYNC_TARGET_READ_FAILED",
  CANCELLED: "SYNC_CANCELLED",
  WRITE_FAILED: "SYNC_WRITE_FAILED",
  LOCK_BUSY: "SYNC_LOCK_BUSY",
  MISSING_FROM: "SYNC_MISSING_FROM",
  MISSING_TO: "SYNC_MISSING_TO",
  UNEXPECTED: "SYNC_UNEXPECTED",
} as const;

export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[keyof typeof SYNC_ERROR_CODES];

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: SyncErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.details = details;
  }
}

export class SyncValidationError extends SyncError {
  constructor(code: SyncErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
    this.name = "SyncValidationError";
  }
}

export function syncJsonErrorPayload(err: SyncError): Record<string, unknown> {
  return { error: err.message, code: err.code, ...err.details };
}

export function printSyncJsonError(err: SyncError): void {
  console.log(JSON.stringify(syncJsonErrorPayload(err), null, 2));
}

const VIEW_ONLY_CLIENT_IDS = new Set(["copilot-agent-host"]);

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

async function fileReadable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function expectedClientConfigPath(
  clientId: string,
  cwd: string,
  deps?: Partial<DetectClientConfigDeps>
): string {
  const id = normalizeClientConfigId(clientId);
  const resolved = resolveDetectClientConfigDeps(deps);
  const home = resolved.homedir();
  const osName = resolved.platform();
  const appData = getAppDataDirFor(osName, home, resolved.env);

  switch (id) {
    case "cursor-global":
      return path.join(home, ".cursor", "mcp.json");
    case "cursor-project":
      return path.join(cwd, ".cursor", "mcp.json");
    case "claude-desktop":
      return path.join(appData, "Claude", "claude_desktop_config.json");
    case "claude-code-global":
      return path.join(home, ".claude.json");
    case "claude-code-project":
      return path.join(cwd, ".mcp.json");
    case "vscode-workspace":
      return path.join(cwd, ".vscode", "mcp.json");
    case "vscode-user":
      return path.join(appData, "Code", "User", "mcp.json");
    case "windsurf":
      return path.join(home, ".codeium", "windsurf", "mcp_config.json");
    case "antigravity-global":
      return path.join(home, ".gemini", "config", "mcp_config.json");
    case "antigravity-workspace":
      return path.join(cwd, ".agents", "mcp_config.json");
    case "gemini-cli-user":
      return path.join(home, ".gemini", "settings.json");
    case "gemini-cli-project":
      return path.join(cwd, ".gemini", "settings.json");
    case "codex":
      return path.join(getCodexHome(home, resolved.env), "config.toml");
    case "codex-project":
      return path.join(cwd, ".codex", "config.toml");
    case "copilot-agent-host":
      return path.join(home, ".copilot", "mcp-config.json");
    default:
      return path.join(cwd, id);
  }
}

function validateClientId(id: string): string {
  const normalized = normalizeClientConfigId(id);
  if (!(ALL_CLIENT_CONFIG_IDS as readonly string[]).includes(normalized)) {
    throw new SyncValidationError(
      SYNC_ERROR_CODES.UNKNOWN_CLIENT,
      `Unknown client id: ${id}. Valid ids: ${ALL_CLIENT_CONFIG_IDS.join(", ")} (alias: vscode -> vscode-user)`,
      { clientId: id }
    );
  }
  return normalized;
}

function emptyNewClientConfig(configPath: string): { parsed: unknown; seedContent: string } {
  const norm = configPath.replace(/\\/g, "/").toLowerCase();
  if (isCodexTomlConfigFile(configPath)) {
    return { parsed: { mcp_servers: {} }, seedContent: "[mcp_servers]\n" };
  }
  const base = path.basename(configPath).toLowerCase();
  if (base === "settings.json") {
    if (norm.includes("/.gemini/")) {
      const parsed = { mcpServers: {} };
      return { parsed, seedContent: JSON.stringify(parsed, null, 2) + "\n" };
    }
    const parsed = { mcp: { servers: {} } };
    return { parsed, seedContent: JSON.stringify(parsed, null, 2) + "\n" };
  }
  if (norm.includes("/.vscode/") && base === "mcp.json") {
    const parsed = { servers: {} };
    return { parsed, seedContent: JSON.stringify(parsed, null, 2) + "\n" };
  }
  const parsed = { mcpServers: {} };
  return { parsed, seedContent: JSON.stringify(parsed, null, 2) + "\n" };
}

async function resolveSourceClient(
  fromClientId: string,
  cwd: string,
  deps?: Partial<DetectClientConfigDeps>
): Promise<ClientConfig> {
  const id = validateClientId(fromClientId);
  const detected = await getClientConfigById(id, cwd, deps);
  if (detected) {
    return detected;
  }
  const expected = expectedClientConfigPath(id, cwd, deps);
  if (!(await fileReadable(expected))) {
    throw new SyncValidationError(
      SYNC_ERROR_CODES.MISSING_SOURCE,
      `Source client "${id}" config not found at ${expected}. Create the file or pick another --from client.`,
      { clientId: id, configPath: expected }
    );
  }
  return {
    id,
    name: id,
    path: expected,
    profile: null,
    viewOnly: VIEW_ONLY_CLIENT_IDS.has(id),
  };
}

async function resolveTargetClients(
  toClientId: string | "all",
  sourceId: string,
  cwd: string,
  deps?: Partial<DetectClientConfigDeps>
): Promise<{ targets: ClientConfig[]; skipped: SyncSkippedClient[] }> {
  const skipped: SyncSkippedClient[] = [];

  if (toClientId !== "all") {
    const id = validateClientId(toClientId);
    if (id === sourceId) {
      throw new SyncValidationError(
        SYNC_ERROR_CODES.SOURCE_EQUALS_TARGET,
        "--from and --to must name different clients.",
        { fromClientId: sourceId, toClientId: id }
      );
    }
    if (VIEW_ONLY_CLIENT_IDS.has(id)) {
      throw new SyncValidationError(
        SYNC_ERROR_CODES.VIEW_ONLY_TARGET,
        `Client "${id}" is view-only and cannot be a sync target.`,
        { clientId: id }
      );
    }
    const detected = await getClientConfigById(id, cwd, deps);
    if (detected) {
      return { targets: [detected], skipped };
    }
    const expected = expectedClientConfigPath(id, cwd, deps);
    return {
      targets: [
        {
          id,
          name: id,
          path: expected,
          profile: null,
          viewOnly: false,
        },
      ],
      skipped,
    };
  }

  const detected = await detectClientConfigs(cwd, deps);
  const byId = new Map(detected.map((c) => [c.id, c]));
  const targets: ClientConfig[] = [];

  for (const id of ALL_CLIENT_CONFIG_IDS) {
    if (id === sourceId) {
      continue;
    }
    if (VIEW_ONLY_CLIENT_IDS.has(id)) {
      skipped.push({
        clientId: id,
        reason: "view-only client (not writable)",
      });
      continue;
    }
    const client = byId.get(id);
    if (!client) {
      skipped.push({
        clientId: id,
        reason: "config file not present on this machine",
      });
      continue;
    }
    if (client.viewOnly) {
      skipped.push({
        clientId: id,
        reason: "view-only client (not writable)",
      });
      continue;
    }
    targets.push(client);
  }

  return { targets, skipped };
}

function rawServerEntry(parsed: unknown, configPath: string, name: string): unknown {
  const surface = getConfigSurface(configPath, parsed);
  return asRecord(surface.extractMcpServers(parsed))[name];
}

function canonicalMapFromConfig(
  parsed: unknown,
  configPath: string
): Map<string, CanonicalMcpServer> {
  const surface = getConfigSurface(configPath, parsed);
  const servers = asRecord(surface.extractMcpServers(parsed));
  const out = new Map<string, CanonicalMcpServer>();
  for (const name of Object.keys(servers)) {
    const raw = rawServerEntry(parsed, configPath, name);
    out.set(name, canonicalizeServerEntry(raw ?? servers[name]));
  }
  return out;
}

function desiredLogicalMapForTarget(
  sourceCanonical: Map<string, CanonicalMcpServer>,
  targetPath: string,
  targetParsed: unknown,
  warnings: string[]
): Record<string, unknown> {
  const kind = inferConfigSurfaceKind(targetPath, targetParsed);
  const caps = capabilitiesForSurfaceKind(kind);
  const logical: Record<string, unknown> = {};

  for (const [name, canonical] of sourceCanonical) {
    const translated = translateCanonicalToTargetLogical(name, canonical, caps);
    if (!translated.ok) {
      warnings.push(translated.warning);
      continue;
    }
    logical[name] = translated.logical;
  }

  return logical;
}

export function planTargetSync(
  sourceCanonical: Map<string, CanonicalMcpServer>,
  target: ClientConfig,
  targetParsed: unknown,
  warnings: string[]
): SyncTargetPlan & { desiredLogical: Record<string, unknown>; merged: unknown } {
  const surface = getConfigSurface(target.path, targetParsed);
  const currentLogical = asRecord(surface.extractMcpServers(targetParsed));
  const desiredLogical = desiredLogicalMapForTarget(
    sourceCanonical,
    target.path,
    targetParsed,
    warnings
  );

  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const skippedServers: Array<{ name: string; reason: string }> = [];

  for (const name of Object.keys(desiredLogical)) {
    if (!(name in currentLogical)) {
      added.push(name);
    } else if (!logicalEntriesEqual(currentLogical[name], desiredLogical[name])) {
      changed.push(name);
    }
  }

  for (const name of Object.keys(currentLogical)) {
    if (!(name in desiredLogical)) {
      removed.push(name);
    }
  }

  for (const [name, canonical] of sourceCanonical) {
    if (name in desiredLogical) {
      continue;
    }
    const kind = inferConfigSurfaceKind(target.path, targetParsed);
    const caps = capabilitiesForSurfaceKind(kind);
    const translated = translateCanonicalToTargetLogical(name, canonical, caps);
    if (!translated.ok) {
      skippedServers.push({ name, reason: translated.warning });
    }
  }

  const merged = mergeProposedOntoClientConfig(targetParsed, target.path, {
    mcpServers: desiredLogical,
  });
  const mergedWithCodexFlags = applyCodexDisabledFromLogical(
    merged,
    target.path,
    desiredLogical
  );

  const noOp = configsSemanticallyEqual(targetParsed, mergedWithCodexFlags);

  return {
    clientId: target.id,
    clientName: target.name,
    configPath: target.path,
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    skippedServers,
    noOp,
    written: false,
    desiredLogical,
    merged: mergedWithCodexFlags,
  };
}

function applyCodexDisabledFromLogical(
  merged: unknown,
  configPath: string,
  desiredLogical: Record<string, unknown>
): unknown {
  if (!isCodexTomlConfigFile(configPath)) {
    return merged;
  }
  const root = asRecord(merged);
  const servers = asRecord(root.mcp_servers);
  for (const [name, logical] of Object.entries(desiredLogical)) {
    if (!(name in servers)) {
      continue;
    }
    const entry = asRecord(servers[name]);
    const desired = asRecord(logical);
    if (desired.enabled === false) {
      entry.enabled = false;
    } else {
      delete entry.enabled;
    }
    servers[name] = entry;
  }
  for (const name of Object.keys(servers)) {
    if (!(name in desiredLogical)) {
      delete servers[name];
    }
  }
  return { ...root, mcp_servers: servers };
}

async function writeTargetConfigNew(
  configPath: string,
  merged: unknown,
  seedContent: string,
  seedParsed: unknown
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await withApplyFileLock(configPath, async () => {
    const surface = getConfigSurface(configPath, seedParsed);
    const serialized = surface.serializeMerged(seedContent, merged);
    const tempPath = `${configPath}.tmp-${makeUniqueTimestamp()}`;
    try {
      await writeFile(tempPath, serialized, "utf8");
      await renameWithRetry(tempPath, configPath);
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw err;
    }
  });
}

async function writeTargetConfigWithBackup(
  configPath: string,
  merged: unknown,
  originalContent: string,
  originalParsed: unknown
): Promise<{ backupPath?: string }> {
  return withApplyFileLock(configPath, async () => {
    const surface = getConfigSurface(configPath, originalParsed);
    const serialized = surface.serializeMerged(originalContent, merged);

    if (configsSemanticallyEqual(originalParsed, merged)) {
      return {};
    }

    let backupPath = `${configPath}.bak-${makeUniqueTimestamp()}`;
    let backupRetries = 0;
    while (backupRetries < 10) {
      try {
        const backupFd = await open(backupPath, "wx");
        await backupFd.writeFile(originalContent, "utf8");
        await backupFd.close();
        break;
      } catch (err: unknown) {
        const code =
          err && typeof err === "object" && "code" in err
            ? (err as { code: string }).code
            : "";
        if (code === "EEXIST" && backupRetries < 9) {
          backupPath = `${configPath}.bak-${makeUniqueTimestamp()}`;
          backupRetries++;
          continue;
        }
        throw err;
      }
    }

    const tempPath = `${configPath}.tmp-${makeUniqueTimestamp()}`;
    try {
      await writeFile(tempPath, serialized, "utf8");
      await renameWithRetry(tempPath, configPath);
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw err;
    }

    return { backupPath };
  });
}

function printHumanPreview(result: SyncMcpClientsResult): void {
  console.log(`Sync plan: ${result.sourceClientId} -> target(s)`);
  console.log(`Source: ${result.sourceConfigPath}`);
  if (result.skippedClients.length > 0) {
    console.log("\nSkipped clients:");
    for (const s of result.skippedClients) {
      console.log(`  - ${s.clientId}: ${s.reason}`);
    }
  }
  for (const t of result.targets) {
    console.log(`\nTarget: ${t.clientName} (${t.clientId})`);
    console.log(`  File: ${t.configPath}`);
    if (t.created) {
      console.log("  (new file — will be created)");
    }
    if (t.noOp) {
      console.log("  (no changes)");
      continue;
    }
    if (t.added.length) {
      console.log(`  Add: ${t.added.join(", ")}`);
    }
    if (t.changed.length) {
      console.log(`  Change: ${t.changed.join(", ")}`);
    }
    if (t.removed.length) {
      console.log(`  Remove: ${t.removed.join(", ")}`);
    }
    if (t.skippedServers.length) {
      for (const s of t.skippedServers) {
        console.log(`  Skip server ${s.name}: ${s.reason}`);
      }
    }
  }
  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of result.warnings) {
      console.log(`  - ${w}`);
    }
  }
}

async function defaultConfirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function syncMcpClients(opts: SyncMcpClientsOptions): Promise<SyncMcpClientsResult> {
  const cwd = opts.cwd ?? process.cwd();
  const warnings: string[] = [];
  const explicitSingleTarget = opts.toClientId !== "all";
  const source = await resolveSourceClient(opts.fromClientId, cwd, opts.detectDeps);
  if (VIEW_ONLY_CLIENT_IDS.has(source.id)) {
    throw new SyncValidationError(
      SYNC_ERROR_CODES.VIEW_ONLY_SOURCE,
      `Source client "${source.id}" is view-only.`,
      { clientId: source.id, configPath: source.path }
    );
  }
  if (!(await fileReadable(source.path))) {
    throw new SyncValidationError(
      SYNC_ERROR_CODES.MISSING_SOURCE,
      `Source client "${source.id}" config not found at ${source.path}.`,
      { clientId: source.id, configPath: source.path }
    );
  }

  const { targets, skipped } = await resolveTargetClients(
    opts.toClientId,
    source.id,
    cwd,
    opts.detectDeps
  );

  let sourceParsed: unknown;
  try {
    const sourceContent = await readFile(source.path, "utf8");
    sourceParsed = parseClientConfigContent(sourceContent, source.path);
  } catch (err) {
    throw new SyncValidationError(
      SYNC_ERROR_CODES.SOURCE_READ_FAILED,
      `Cannot read source config: ${formatConfigLoadError(err)}`,
      { clientId: source.id, configPath: source.path }
    );
  }

  const sourceCanonical = canonicalMapFromConfig(sourceParsed, source.path);

  type InternalPlan = SyncTargetPlan & {
    desiredLogical: Record<string, unknown>;
    merged: unknown;
    originalContent: string;
    originalParsed: unknown;
    createNew: boolean;
  };

  const targetPlans: InternalPlan[] = [];

  for (const target of targets) {
    const exists = await fileReadable(target.path);
    if (!exists) {
      if (!explicitSingleTarget) {
        skipped.push({
          clientId: target.id,
          reason: `config file not found at ${target.path}`,
        });
        continue;
      }
      const seed = emptyNewClientConfig(target.path);
      const plan = planTargetSync(sourceCanonical, target, seed.parsed, warnings);
      targetPlans.push({
        ...plan,
        created: true,
        createNew: true,
        originalContent: seed.seedContent,
        originalParsed: seed.parsed,
      });
      continue;
    }
    let targetContent: string;
    let targetParsed: unknown;
    try {
      targetContent = await readFile(target.path, "utf8");
      targetParsed = parseClientConfigContent(targetContent, target.path);
    } catch (err) {
      const message = `Target ${target.id}: cannot read config (${formatConfigLoadError(err)}).`;
      if (explicitSingleTarget) {
        throw new SyncValidationError(SYNC_ERROR_CODES.TARGET_READ_FAILED, message, {
          clientId: target.id,
          configPath: target.path,
        });
      }
      warnings.push(`${message}; skipped.`);
      continue;
    }
    const plan = planTargetSync(sourceCanonical, target, targetParsed, warnings);
    targetPlans.push({
      ...plan,
      createNew: false,
      originalContent: targetContent,
      originalParsed: targetParsed,
    });
  }

  const stripInternal = (p: InternalPlan): SyncTargetPlan => {
    const { desiredLogical: _d, merged: _m, originalContent: _c, originalParsed: _p, ...t } = p;
    return t;
  };

  const resultBase: SyncMcpClientsResult = {
    sourceClientId: source.id,
    sourceConfigPath: source.path,
    dryRun: Boolean(opts.dryRun),
    applied: false,
    cancelled: false,
    skippedClients: skipped,
    targets: targetPlans.map(stripInternal),
    warnings: [...warnings],
  };

  const dryRun = opts.dryRun === true;
  const needsWrite = targetPlans.some((t) => !t.noOp || t.createNew);

  if (!opts.json) {
    printHumanPreview(resultBase);
  }

  if (dryRun) {
    if (opts.json) {
      console.log(JSON.stringify({ ...resultBase, applied: false }, null, 2));
    } else {
      console.log("\nDry-run: no files written (no backups).");
    }
    return resultBase;
  }

  if (needsWrite && !opts.yes) {
    const confirmFn = opts.confirm ?? defaultConfirm;
    const ok = await confirmFn("Apply sync to all targets above?");
    if (!ok) {
      throw new SyncValidationError(
        SYNC_ERROR_CODES.CANCELLED,
        "Sync cancelled; no files written.",
        {}
      );
    }
  }

  const appliedTargets: SyncTargetPlan[] = [];
  for (const plan of targetPlans) {
    const { merged, originalContent, originalParsed, createNew, ...publicPlan } = plan;
    if (plan.noOp && !createNew) {
      appliedTargets.push({ ...publicPlan, written: false });
      continue;
    }
    try {
      if (createNew) {
        await writeTargetConfigNew(plan.configPath, merged, originalContent, originalParsed);
        appliedTargets.push({
          ...publicPlan,
          written: true,
          created: true,
        });
        continue;
      }
      const { backupPath } = await writeTargetConfigWithBackup(
        plan.configPath,
        merged,
        originalContent,
        originalParsed
      );
      appliedTargets.push({
        ...publicPlan,
        written: true,
        backupPath,
      });
    } catch (err) {
      const code =
        err instanceof ApplyLockError ? SYNC_ERROR_CODES.LOCK_BUSY : SYNC_ERROR_CODES.WRITE_FAILED;
      const msg =
        err instanceof ApplyLockError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      if (explicitSingleTarget) {
        throw new SyncError(code, `Target ${plan.clientId}: write failed (${msg}).`, {
          clientId: plan.clientId,
          configPath: plan.configPath,
        });
      }
      warnings.push(`Target ${plan.clientId}: write failed (${msg}).`);
      appliedTargets.push({ ...publicPlan, written: false });
    }
  }

  const finalResult: SyncMcpClientsResult = {
    ...resultBase,
    targets: appliedTargets,
    warnings,
    applied: appliedTargets.some((t) => t.written),
  };

  if (opts.json) {
    console.log(JSON.stringify(finalResult, null, 2));
  } else {
    if (finalResult.warnings.length > 0) {
      console.log("\nWarnings:");
      for (const w of finalResult.warnings) {
        console.log(`  - ${w}`);
      }
    }
    for (const t of appliedTargets.filter((x) => x.written)) {
      console.log(`\nSynced: ${t.configPath}`);
      if (t.backupPath) {
        console.log(`Backup: ${t.backupPath}`);
      }
    }
  }

  return finalResult;
}
