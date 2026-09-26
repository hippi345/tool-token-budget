import type { ConfigSurfaceKind } from "../config/configSurfaces.js";

export interface CanonicalMcpServer {
  disabled: boolean;
  /** Logical transport fields copied when supported on the target. */
  fields: Record<string, unknown>;
}

export interface TargetClientCapabilities {
  kind: ConfigSurfaceKind;
  supportsDisabled: boolean;
  /** When false, use `enabled: false` instead of `disabled: true` (Codex TOML). */
  disabledUsesEnabledFalse: boolean;
  supportedFieldKeys: ReadonlySet<string>;
}

const MCP_JSON_FIELDS = new Set([
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "type",
  "disabled",
  "enabled",
]);

const VSCODE_FIELDS = new Set([
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "type",
]);

const CODEX_FIELDS = new Set(["command", "args", "env", "cwd", "url"]);

export function capabilitiesForSurfaceKind(kind: ConfigSurfaceKind): TargetClientCapabilities {
  switch (kind) {
    case "vscode-servers":
    case "vscode-settings":
      return {
        kind,
        supportsDisabled: false,
        disabledUsesEnabledFalse: false,
        supportedFieldKeys: VSCODE_FIELDS,
      };
    case "codex-toml":
      return {
        kind,
        supportsDisabled: true,
        disabledUsesEnabledFalse: true,
        supportedFieldKeys: CODEX_FIELDS,
      };
    default:
      return {
        kind,
        supportsDisabled: true,
        disabledUsesEnabledFalse: false,
        supportedFieldKeys: MCP_JSON_FIELDS,
      };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Read a server entry from any client surface into canonical form. */
export function canonicalizeServerEntry(raw: unknown): CanonicalMcpServer {
  const e = asRecord(raw);
  const disabled = e.disabled === true || e.enabled === false;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(e)) {
    if (key === "disabled" || key === "enabled") {
      continue;
    }
    fields[key] = value;
  }
  return { disabled, fields };
}

export type TranslateServerResult =
  | { ok: true; logical: Record<string, unknown> }
  | { ok: false; warning: string };

/**
 * Translate a canonical server into the target client's logical MCP map entry
 * (same shape as configSurfaces extractMcpServers values).
 */
export function translateCanonicalToTargetLogical(
  name: string,
  canonical: CanonicalMcpServer,
  caps: TargetClientCapabilities
): TranslateServerResult {
  if (canonical.disabled && !caps.supportsDisabled) {
    return {
      ok: false,
      warning: `Server "${name}": target client does not support a disabled flag; skipping server (would lose disabled state).`,
    };
  }

  const unsupported: string[] = [];
  const logical: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(canonical.fields)) {
    if (caps.supportedFieldKeys.has(key)) {
      logical[key] = value;
    } else {
      unsupported.push(key);
    }
  }
  if (unsupported.length > 0) {
    return {
      ok: false,
      warning: `Server "${name}": target does not support field(s) ${unsupported.join(", ")}; skipping server to avoid data loss.`,
    };
  }

  const hasCommand = typeof logical.command === "string";
  const hasUrl =
    typeof logical.url === "string" ||
    logical.type === "sse" ||
    logical.type === "http";
  if (!hasCommand && !hasUrl) {
    return {
      ok: false,
      warning: `Server "${name}": no command or url transport in source entry; skipping.`,
    };
  }

  if (
    (caps.kind === "vscode-servers" || caps.kind === "vscode-settings") &&
    hasCommand &&
    logical.type === undefined
  ) {
    logical.type = "stdio";
  }

  if (canonical.disabled) {
    if (caps.disabledUsesEnabledFalse) {
      logical.enabled = false;
    } else {
      logical.disabled = true;
    }
  }

  return { ok: true, logical };
}

export function logicalEntriesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}
