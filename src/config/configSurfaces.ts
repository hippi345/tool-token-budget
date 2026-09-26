import { existsSync } from "node:fs";
import path from "node:path";
import { modify, applyEdits } from "jsonc-parser";
import { parseVSCodeSettingsJsonc } from "../discover/clientConfigs.js";
import { parseJSON } from "../utils/json.js";
import {
  detectJsonIndent,
  detectTextEol,
  serializeJsonPreservingStyle,
} from "../utils/configFormat.js";
import {
  extractCodexMcpServers,
  isCodexTomlConfigFile,
  mergeCodexMcpServers,
  parseCodexConfigToml,
  serializeCodexConfigMerged,
} from "./codexToml.js";
import type { EmitProfile } from "../types.js";
import { defaultProposedFilename } from "../branding/artifactPaths.js";

export type ConfigSurfaceKind =
  | "mcpServers"
  | "vscode-servers"
  | "vscode-settings"
  | "gemini-settings"
  | "codex-toml";

export interface ConfigSurface {
  kind: ConfigSurfaceKind;
  extractMcpServers(parsed: unknown): Record<string, unknown>;
  mergeMcpServers(parsed: unknown, mcpServers: Record<string, unknown>): unknown;
  serializeMerged(originalContent: string, merged: unknown): string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function mcpServerToVscodeServer(
  entry: unknown,
  previous?: unknown
): Record<string, unknown> {
  const prev = asRecord(previous);
  const next = asRecord(entry);
  const merged: Record<string, unknown> = { ...next };
  if (typeof merged.command === "string" && merged.type === undefined) {
    merged.type = typeof prev.type === "string" ? prev.type : "stdio";
  }
  return preserveObjectKeyOrder(prev, merged);
}

function preserveObjectKeyOrder(
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

function mergeServerMapsPreservingOrder(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  mapEntry: (name: string, entry: unknown) => unknown
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(previous)) {
    if (name in next) {
      out[name] = mapEntry(name, next[name]);
    }
  }
  for (const name of Object.keys(next)) {
    if (!(name in out)) {
      out[name] = mapEntry(name, next[name]);
    }
  }
  return out;
}

function vscodeServerToMcpServer(entry: unknown): Record<string, unknown> {
  const e = { ...asRecord(entry) };
  delete e.type;
  return e;
}

const mcpServersSurface: ConfigSurface = {
  kind: "mcpServers",
  extractMcpServers(parsed) {
    return asRecord(asRecord(parsed).mcpServers);
  },
  mergeMcpServers(parsed, mcpServers) {
    const root = asRecord(parsed);
    const prevServers = asRecord(root.mcpServers);
    const merged = mergeServerMapsPreservingOrder(
      prevServers,
      mcpServers,
      (_name, entry) => entry
    );
    return { ...root, mcpServers: merged };
  },
  serializeMerged(originalContent, merged) {
    return serializeJsonPreservingStyle(merged, originalContent);
  },
};

const vscodeServersSurface: ConfigSurface = {
  kind: "vscode-servers",
  extractMcpServers(parsed) {
    const servers = asRecord(asRecord(parsed).servers);
    const out: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(servers)) {
      out[name] = vscodeServerToMcpServer(entry);
    }
    return out;
  },
  mergeMcpServers(parsed, mcpServers) {
    const root = asRecord(parsed);
    const prevServers = asRecord(root.servers);
    const servers = mergeServerMapsPreservingOrder(
      prevServers,
      mcpServers,
      (name, entry) => mcpServerToVscodeServer(entry, prevServers[name])
    );
    return { ...root, servers };
  },
  serializeMerged(originalContent, merged) {
    const servers = asRecord(asRecord(merged).servers);
    const prev = parseJSON(originalContent);
    const prevServers = asRecord(asRecord(prev).servers);
    const ordered = mergeServerMapsPreservingOrder(
      prevServers,
      servers,
      (name, entry) => mcpServerToVscodeServer(entry, prevServers[name])
    );
    const indent = detectJsonIndent(originalContent);
    const tabSize = indent.includes("\t") ? 1 : indent.length || 2;
    const edits = modify(originalContent, ["servers"], ordered, {
      formattingOptions: {
        insertSpaces: !indent.includes("\t"),
        tabSize,
        eol: detectTextEol(originalContent) === "\r\n" ? "\r\n" : "\n",
      },
    });
    return applyEdits(originalContent, edits);
  },
};

const vscodeSettingsSurface: ConfigSurface = {
  kind: "vscode-settings",
  extractMcpServers(parsed) {
    const mcp = asRecord(asRecord(parsed).mcp);
    const servers = asRecord(mcp.servers);
    const out: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(servers)) {
      out[name] = vscodeServerToMcpServer(entry);
    }
    return out;
  },
  mergeMcpServers(parsed, mcpServers) {
    const root = asRecord(parsed);
    const mcp = asRecord(root.mcp);
    const prevServers = asRecord(mcp.servers);
    const servers = mergeServerMapsPreservingOrder(
      prevServers,
      mcpServers,
      (name, entry) => mcpServerToVscodeServer(entry, prevServers[name])
    );
    return { ...root, mcp: { ...mcp, servers } };
  },
  serializeMerged(originalContent, merged) {
    const mcpServers = vscodeSettingsSurface.extractMcpServers(merged);
    const vscodeServers: Record<string, unknown> = {};
    const prev = parseVSCodeSettingsJsonc(originalContent);
    const prevServers = asRecord(asRecord(asRecord(prev).mcp).servers);
    for (const name of Object.keys(prevServers)) {
      if (name in mcpServers) {
        vscodeServers[name] = mcpServerToVscodeServer(mcpServers[name], prevServers[name]);
      }
    }
    for (const name of Object.keys(mcpServers)) {
      if (!(name in vscodeServers)) {
        vscodeServers[name] = mcpServerToVscodeServer(mcpServers[name], prevServers[name]);
      }
    }
    const indent = detectJsonIndent(originalContent);
    const tabSize = indent.includes("\t") ? 1 : indent.length || 2;
    const edits = modify(originalContent, ["mcp", "servers"], vscodeServers, {
      formattingOptions: {
        insertSpaces: !indent.includes("\t"),
        tabSize,
        eol: detectTextEol(originalContent) === "\r\n" ? "\r\n" : "\n",
      },
    });
    return applyEdits(originalContent, edits);
  },
};

const geminiSettingsSurface: ConfigSurface = {
  kind: "gemini-settings",
  extractMcpServers(parsed) {
    return asRecord(asRecord(parsed).mcpServers);
  },
  mergeMcpServers(parsed, mcpServers) {
    const root = asRecord(parsed);
    const prevServers = asRecord(root.mcpServers);
    const merged = mergeServerMapsPreservingOrder(
      prevServers,
      mcpServers,
      (_name, entry) => entry
    );
    return { ...root, mcpServers: merged };
  },
  serializeMerged(originalContent, merged) {
    const mcpServers = geminiSettingsSurface.extractMcpServers(merged);
    const prev = parseClientConfigContent(originalContent, "settings.json");
    const prevServers = asRecord(asRecord(prev).mcpServers);
    const ordered = mergeServerMapsPreservingOrder(
      prevServers,
      mcpServers,
      (_name, entry) => entry
    );
    const indent = detectJsonIndent(originalContent);
    const tabSize = indent.includes("\t") ? 1 : indent.length || 2;
    const edits = modify(originalContent, ["mcpServers"], ordered, {
      formattingOptions: {
        insertSpaces: !indent.includes("\t"),
        tabSize,
        eol: detectTextEol(originalContent) === "\r\n" ? "\r\n" : "\n",
      },
    });
    return applyEdits(originalContent, edits);
  },
};

const codexTomlSurface: ConfigSurface = {
  kind: "codex-toml",
  extractMcpServers(parsed) {
    return extractCodexMcpServers(parsed);
  },
  mergeMcpServers(parsed, mcpServers) {
    return mergeCodexMcpServers(parsed, mcpServers);
  },
  serializeMerged(originalContent, merged) {
    return serializeCodexConfigMerged(originalContent, merged);
  },
};

export function inferConfigSurfaceKind(
  filePath: string,
  parsed: unknown
): ConfigSurfaceKind {
  if (isCodexTomlConfigFile(filePath)) {
    return "codex-toml";
  }

  const base = path.basename(filePath).toLowerCase();
  const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();

  if (base === "settings.json") {
    if (normalizedPath.includes("/.gemini/") || normalizedPath.endsWith("/.gemini/settings.json")) {
      return "gemini-settings";
    }
    return "vscode-settings";
  }

  const root = asRecord(parsed);
  if (
    root.servers &&
    typeof root.servers === "object" &&
    !Array.isArray(root.servers) &&
    root.mcpServers === undefined
  ) {
    return "vscode-servers";
  }

  return "mcpServers";
}

export function getConfigSurface(filePath: string, parsed: unknown): ConfigSurface {
  const kind = inferConfigSurfaceKind(filePath, parsed);
  switch (kind) {
    case "vscode-servers":
      return vscodeServersSurface;
    case "vscode-settings":
      return vscodeSettingsSurface;
    case "gemini-settings":
      return geminiSettingsSurface;
    case "codex-toml":
      return codexTomlSurface;
    default:
      return mcpServersSurface;
  }
}

export function parseClientConfigContent(content: string, filePath: string): unknown {
  if (isCodexTomlConfigFile(filePath)) {
    return parseCodexConfigToml(content);
  }
  const base = path.basename(filePath).toLowerCase();
  if (base === "settings.json" || base.endsWith(".jsonc")) {
    return parseVSCodeSettingsJsonc(content);
  }
  return parseJSON(content);
}

export function getServerNamesFromClientConfig(
  parsed: unknown,
  filePath: string
): Set<string> {
  const surface = getConfigSurface(filePath, parsed);
  return new Set(Object.keys(surface.extractMcpServers(parsed)));
}

export function isRecognizedMcpConfigShape(parsed: unknown, filePath?: string): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const root = parsed as Record<string, unknown>;
  if (filePath && isCodexTomlConfigFile(filePath)) {
    const mcpServers = root.mcp_servers;
    return (
      mcpServers !== undefined &&
      mcpServers !== null &&
      typeof mcpServers === "object" &&
      !Array.isArray(mcpServers)
    );
  }
  if (root.mcpServers !== undefined) {
    const mcpServers = root.mcpServers;
    return (
      mcpServers !== null &&
      typeof mcpServers === "object" &&
      !Array.isArray(mcpServers)
    );
  }
  if (root.servers !== undefined) {
    const servers = root.servers;
    return servers !== null && typeof servers === "object" && !Array.isArray(servers);
  }
  if (filePath && path.basename(filePath).toLowerCase() === "settings.json") {
    const mcp = root.mcp;
    if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
      const servers = (mcp as Record<string, unknown>).servers;
      return (
        servers !== undefined &&
        servers !== null &&
        typeof servers === "object" &&
        !Array.isArray(servers)
      );
    }
    if (filePath.replace(/\\/g, "/").toLowerCase().includes("/.gemini/")) {
      const mcpServers = root.mcpServers;
      return (
        mcpServers !== undefined &&
        mcpServers !== null &&
        typeof mcpServers === "object" &&
        !Array.isArray(mcpServers)
      );
    }
  }
  return false;
}

export function logicalConfigForProposal(
  parsed: unknown,
  filePath: string
): Record<string, unknown> {
  const surface = getConfigSurface(filePath, parsed);
  return { mcpServers: surface.extractMcpServers(parsed) };
}

export function mergeProposedOntoClientConfig(
  parsed: unknown,
  filePath: string,
  proposedLogical: unknown
): unknown {
  const surface = getConfigSurface(filePath, parsed);
  const mcpServers = asRecord(asRecord(proposedLogical).mcpServers);
  return surface.mergeMcpServers(parsed, mcpServers);
}

export function proposedExportBasename(configPath: string): string {
  return `${path.basename(configPath)}.tool-token-budget-proposed.json`;
}

export function proposedExportFilenameForClient(client: {
  path: string;
  profile: EmitProfile | null;
}): string {
  if (
    client.profile === "vscode" ||
    client.profile === "windsurf" ||
    client.profile === "gemini-settings" ||
    client.profile === "antigravity" ||
    client.profile === "codex"
  ) {
    return proposedExportBasename(client.path);
  }
  return defaultProposedFilename();
}

export function emitProfileForClientId(clientId: string): EmitProfile | null {
  if (clientId.startsWith("vscode-")) return "vscode";
  if (clientId === "windsurf") return "windsurf";
  if (clientId.startsWith("gemini-cli-")) return "gemini-settings";
  if (clientId.startsWith("antigravity-")) return "antigravity";
  if (clientId === "codex" || clientId === "codex-project") return "codex";
  if (clientId.startsWith("claude-code-")) return "claude";
  if (clientId.startsWith("cursor-")) return "cursor";
  if (clientId === "claude-desktop") return "claude";
  return null;
}

export function vscodeWorkspaceMcpPrecedenceWarning(cwd: string): string | null {
  const vscodeWorkspace = path.join(cwd, ".vscode", "mcp.json");
  const portable = path.join(cwd, ".mcp.json");
  if (existsSync(vscodeWorkspace) && existsSync(portable)) {
    return (
      "Both .vscode/mcp.json and .mcp.json exist; VS Code prefers .vscode/mcp.json for workspace MCP."
    );
  }
  return null;
}
