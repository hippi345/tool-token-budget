import { readConfigUtf8WithRetry } from "../config/readConfigWithRetry.js";
import type { Server, Tool } from "../types.js";
import { listToolsStdio } from "./stdioListTools.js";
import { parseJSON } from "../utils/json.js";
import {
  getConfigSurface,
  parseClientConfigContent,
} from "../config/configSurfaces.js";
import { isCodexTomlConfigFile } from "../config/codexToml.js";
import { redactUrlString, redactArgString } from "../utils/redact.js";

export type ParsedServer =
  | {
      name: string;
      kind: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      name: string;
      kind: "remote";
      url?: string;
      raw: unknown;
    };

/** Deep-clone and replace any object key `env`'s values with "***". */
export function redactEnv<T>(obj: T): T {
  return redactWalk(obj) as T;
}

function redactWalk(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(redactWalk);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "env" && v && typeof v === "object" && !Array.isArray(v)) {
      const envOut: Record<string, string> = {};
      for (const ek of Object.keys(v as Record<string, unknown>)) {
        envOut[ek] = "***";
      }
      out[k] = envOut;
    } else {
      out[k] = redactWalk(v);
    }
  }
  return out;
}

export function isMcpServerConfigDisabled(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  return (entry as Record<string, unknown>).disabled === true ||
    (entry as Record<string, unknown>).enabled === false;
}

/** Parse Cursor/Claude-style `{ mcpServers: { name: { command, args?, env? } } }`. */
export function parseMcpConfig(raw: unknown): ParsedServer[] {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid MCP config: expected object with mcpServers");
  }
  const mcpServers = (raw as Record<string, unknown>).mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    throw new Error("Invalid MCP config: missing mcpServers object");
  }
  const result: ParsedServer[] = [];
  for (const [name, entry] of Object.entries(
    mcpServers as Record<string, unknown>
  )) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.command === "string") {
      result.push({
        name,
        kind: "stdio",
        command: e.command,
        args: Array.isArray(e.args) ? e.args.map(String) : undefined,
        env:
          e.env && typeof e.env === "object" && !Array.isArray(e.env)
            ? Object.fromEntries(
                Object.entries(e.env as Record<string, unknown>).map(([k, v]) => [
                  k,
                  String(v),
                ])
              )
            : undefined,
        cwd: typeof e.cwd === "string" ? e.cwd : undefined,
      });
    } else if (typeof e.url === "string" || e.type === "sse" || e.type === "http") {
      result.push({ name, kind: "remote", url: typeof e.url === "string" ? e.url : undefined, raw: e });
    } else {
      // Unknown — treat as remote/skip
      result.push({ name, kind: "remote", raw: e });
    }
  }
  return result;
}

export interface DiscoverMcpOptions {
  timeoutMs?: number;
  /** Called for warnings (remote skip, etc.) */
  onWarn?: (msg: string) => void;
  /** Dedupe remote-skip warnings across poll ticks */
  warnedRemoteServers?: Set<string>;
}

function mcpServerConfigEntry(
  raw: unknown,
  configPath: string,
  serverName: string
): unknown {
  if (isCodexTomlConfigFile(configPath)) {
    return asRecord(asRecord(raw).mcp_servers)[serverName];
  }
  return (getConfigSurface(configPath, raw).extractMcpServers(raw) as Record<string, unknown>)[
    serverName
  ];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Load mcp.json path, discover tools from stdio servers; warn+skip remote. */
export async function discoverFromMcpConfig(
  configPath: string,
  opts: DiscoverMcpOptions & { configContent?: string } = {}
): Promise<{ servers: Server[]; tools: Tool[] }> {
  const fileContent =
    opts.configContent ?? (await readConfigUtf8WithRetry(configPath));
  const raw = parseClientConfigContent(fileContent, configPath);
  const surface = getConfigSurface(configPath, raw);
  const parsed = parseMcpConfig({ mcpServers: surface.extractMcpServers(raw) });
  const servers: Server[] = [];
  const tools: Tool[] = [];
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const warn = opts.onWarn ?? ((m: string) => console.error(m));
  const warnedRemote = opts.warnedRemoteServers ?? new Set<string>();

  for (const s of parsed) {
    const entry = mcpServerConfigEntry(raw, configPath, s.name);
    if (isMcpServerConfigDisabled(entry)) {
      servers.push({
        name: s.name,
        status: "config_disabled",
        transportSummary: "disabled in config",
      });
      continue;
    }

    if (s.kind === "remote") {
      // Redact URL before logging to prevent password/token leaks
      const redactedUrl = s.url ? redactUrlString(s.url) : "";
      if (!warnedRemote.has(s.name)) {
        warnedRemote.add(s.name);
        warn(
          `warn: skipping remote/OAuth server "${s.name}"${redactedUrl ? ` (${redactedUrl})` : ""}; use --tools-json for offline metering`
        );
      }
      servers.push({
        name: s.name,
        status: "skipped_remote",
        transportSummary: s.url ? `remote:${s.url}` : "remote",
        error: "Remote/OAuth not supported in v1 live discover",
      });
      continue;
    }

    const summary = redactEnv({
      command: s.command,
      args: s.args,
      env: s.env,
    });
    try {
      const listed = await listToolsStdio(
        {
          name: s.name,
          command: s.command,
          args: s.args,
          env: s.env,
          cwd: s.cwd,
        },
        timeoutMs
      );
      servers.push({
        name: s.name,
        status: listed.status,
        transportSummary: `stdio:${s.command}`,
        error: listed.error ? `${s.command}: ${listed.error}` : undefined,
      });
      // Attach redacted summary note only in transportSummary string — never leak env
      void summary;
      for (const t of listed.tools) {
        tools.push(t);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Include command in error to make failures identifiable across platforms
      const errorWithCmd = msg.includes(s.command) ? msg : `${s.command}: ${msg}`;
      servers.push({
        name: s.name,
        status: "spawn_failed",
        transportSummary: `stdio:${s.command}`,
        error: errorWithCmd,
      });
    }
  }

  return { servers, tools };
}
