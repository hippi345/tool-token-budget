import path from "node:path";
import { patch, parse } from "@decimalturn/toml-patch";

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Paths under `.codex/config.toml` (user or project). */
export function isCodexConfigPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  return norm.endsWith("/.codex/config.toml");
}

/** Codex TOML configs: canonical `.codex/config.toml` paths or any `.toml` file. */
export function isCodexTomlConfigFile(filePath: string): boolean {
  if (isCodexConfigPath(filePath)) {
    return true;
  }
  return path.basename(filePath).toLowerCase().endsWith(".toml");
}

export function getCodexHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEX_HOME?.trim();
  if (override) {
    return override;
  }
  return path.join(home, ".codex");
}

export function parseCodexConfigToml(content: string): unknown {
  try {
    return parse(content);
  } catch (err) {
    throw new SyntaxError(err instanceof Error ? err.message : String(err));
  }
}

const LOGICAL_MCP_KEYS = new Set(["command", "args", "env", "cwd", "url"]);

export function codexServerToLogicalMcp(entry: unknown): Record<string, unknown> {
  const e = asRecord(entry);
  const out: Record<string, unknown> = {};
  for (const key of LOGICAL_MCP_KEYS) {
    if (key in e) {
      out[key] = e[key];
    }
  }
  return out;
}

export function logicalMcpToCodexServer(
  logical: unknown,
  previous?: unknown
): Record<string, unknown> {
  const prev = asRecord(previous);
  const next = asRecord(logical);
  const merged: Record<string, unknown> = { ...prev };
  for (const key of LOGICAL_MCP_KEYS) {
    if (key in next) {
      merged[key] = next[key];
    } else {
      delete merged[key];
    }
  }
  return preserveKeyOrder(prev, merged);
}

function preserveKeyOrder(
  previous: Record<string, unknown>,
  merged: Record<string, unknown>
): Record<string, unknown> {
  const prevKeys = Object.keys(previous);
  if (prevKeys.length === 0) {
    return merged;
  }
  const out: Record<string, unknown> = {};
  for (const key of prevKeys) {
    if (key in merged) {
      out[key] = merged[key];
    }
  }
  for (const key of Object.keys(merged)) {
    if (!(key in out)) {
      out[key] = merged[key];
    }
  }
  return out;
}

function mergeCodexServerMaps(
  previous: Record<string, unknown>,
  nextLogical: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(previous)) {
    if (name in nextLogical) {
      out[name] = logicalMcpToCodexServer(nextLogical[name], previous[name]);
    }
  }
  for (const name of Object.keys(nextLogical)) {
    if (!(name in out)) {
      out[name] = logicalMcpToCodexServer(nextLogical[name], previous[name]);
    }
  }
  return out;
}

export function extractCodexMcpServers(parsed: unknown): Record<string, unknown> {
  const servers = asRecord(asRecord(parsed).mcp_servers);
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(servers)) {
    out[name] = codexServerToLogicalMcp(entry);
  }
  return out;
}

export function mergeCodexMcpServers(
  parsed: unknown,
  logicalMcpServers: Record<string, unknown>
): unknown {
  const root = asRecord(parsed);
  const prev = asRecord(root.mcp_servers);
  return {
    ...root,
    mcp_servers: mergeCodexServerMaps(prev, logicalMcpServers),
  };
}

export function serializeCodexConfigMerged(
  originalContent: string,
  mergedRoot: unknown
): string {
  return patch(originalContent, mergedRoot);
}
