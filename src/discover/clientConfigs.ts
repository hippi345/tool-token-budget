import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { access, constants, readFile } from "node:fs/promises";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { EmitProfile } from "../types.js";
import { getCodexHome } from "../config/codexToml.js";

export interface DetectClientConfigDeps {
  homedir: () => string;
  platform: () => NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export interface ClientConfig {
  id: string;
  name: string;
  path: string;
  profile: EmitProfile | null;
  viewOnly: boolean;
}

/** Every client id the CLI/GUI recognize (--client values). */
export const ALL_CLIENT_CONFIG_IDS = [
  "cursor-global",
  "cursor-project",
  "claude-desktop",
  "claude-code-global",
  "claude-code-project",
  "vscode-workspace",
  "vscode-user",
  "windsurf",
  "antigravity-global",
  "antigravity-workspace",
  "gemini-cli-user",
  "gemini-cli-project",
  "codex",
  "codex-project",
  "copilot-agent-host",
] as const;

const CLIENT_ID_ALIASES: Record<string, string> = {
  vscode: "vscode-user",
};

export function normalizeClientConfigId(id: string): string {
  return CLIENT_ID_ALIASES[id] ?? id;
}

/**
 * Auto-detect MCP client configs on this machine.
 * 
 * Paths verified from official documentation:
 * 
 * - **Cursor**: 
 *   - Global: ~/.cursor/mcp.json (all OSes)
 *   - Project: .cursor/mcp.json (all OSes)
 *   - Source: https://docs.cursor.com/advanced/mcp
 *   - Schema: uses `mcpServers` key
 * 
 * - **Claude Desktop**:
 *   - macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
 *   - Windows: %APPDATA%/Claude/claude_desktop_config.json
 *   - Linux: ~/.config/Claude/claude_desktop_config.json (Beta, Ubuntu 22.04+ / Debian 12+)
 *   - Source: https://modelcontextprotocol.io/quickstart/user
 *   - Source (Linux): https://code.claude.com/docs/en/desktop-linux
 *   - Schema: uses `mcpServers` key
 * 
 * - **Claude Code**:
 *   - Global: ~/.claude.json (all OSes)
 *   - Project: .mcp.json (all OSes)
 *   - Source: Claude Code extension documentation
 *   - Schema: uses `mcpServers` key
 * 
 * - **VS Code**:
 *   - Workspace: .vscode/mcp.json
 *   - User (macOS): ~/Library/Application Support/Code/User/settings.json (or mcp.json)
 *   - User (Windows): %APPDATA%/Code/User/settings.json (or mcp.json)
 *   - User (Linux): ~/.config/Code/User/settings.json (or mcp.json)
 *   - Source: https://code.visualstudio.com/docs/agent-customization/mcp-servers
 *   - Schema: uses `servers` key (NOT `mcpServers`), or `mcp.servers` in settings.json
 *   - Note: View-only (different schema structure)
 * 
 * - **Windsurf**:
 *   - Global only: ~/.codeium/windsurf/mcp_config.json (all OSes)
 *   - Source: https://docs.onesource.io/getting-started/mcp/configure-windsurf
 *   - Schema: uses `mcpServers` key
 *   - Note: View-only (no emit profile yet)
 * 
 * - **Google Antigravity**:
 *   - Global: ~/.gemini/config/mcp_config.json (all OSes)
 *   - Workspace: .agents/mcp_config.json (all OSes)
 *   - Source: https://www.antigravity.google/docs/ide/mcp/
 *   - Schema: uses `mcpServers` key
 *   - Note: View-only (no emit profile yet)
 * 
 * - **Gemini CLI**:
 *   - User: ~/.gemini/settings.json (all OSes)
 *   - Project: .gemini/settings.json (all OSes)
 *   - Source: https://github.com/google-gemini/gemini-cli/blob/HEAD/docs/reference/configuration.md
 *   - Schema: uses `mcpServers` key nested in settings
 *   - Note: View-only (no emit profile yet)
 */

export { getCodexHome } from "../config/codexToml.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Strip line and block comments so JSONC settings.json can be inspected (read-only discovery). */
export function stripJsoncComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < text.length) {
        const c = text[i];
        out += c;
        i++;
        if (c === "\\" && i < text.length) {
          out += text[i];
          i++;
          continue;
        }
        if (c === '"') {
          break;
        }
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Parse VS Code settings.json text (BOM, comments, trailing commas). */
export function parseVSCodeSettingsJsonc(text: string): unknown {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const errors: ParseError[] = [];
  return parseJsonc(withoutBom, errors, { allowTrailingComma: true });
}

export function settingsJsonHasLegacyMcpServersFromText(text: string): boolean {
  try {
    const parsed = parseVSCodeSettingsJsonc(text) as {
      mcp?: { servers?: unknown };
    };
    const servers = parsed?.mcp?.servers;
    return Boolean(servers && typeof servers === "object" && !Array.isArray(servers));
  } catch {
    return false;
  }
}

export async function settingsJsonHasLegacyMcpServers(settingsPath: string): Promise<boolean> {
  try {
    const raw = await readFile(settingsPath, "utf8");
    return settingsJsonHasLegacyMcpServersFromText(raw);
  } catch {
    return false;
  }
}

function clientConfigPathKey(filePath: string, osName: NodeJS.Platform): string {
  const resolved = resolve(filePath);
  return osName === "win32" || osName === "darwin" ? resolved.toLowerCase() : resolved;
}

function dedupeClientConfigsByPath(
  configs: ClientConfig[],
  osName: NodeJS.Platform
): ClientConfig[] {
  const byPath = new Map<string, ClientConfig>();
  for (const c of configs) {
    const key = clientConfigPathKey(c.path, osName);
    if (!byPath.has(key)) {
      byPath.set(key, c);
    }
  }
  return [...byPath.values()];
}

export function getAppDataDirFor(
  osName: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  switch (osName) {
    case "win32":
      return env.APPDATA || join(home, "AppData", "Roaming");
    case "darwin":
      return join(home, "Library", "Application Support");
    default:
      return env.XDG_CONFIG_HOME || join(home, ".config");
  }
}

function getAppDataDir(): string {
  return getAppDataDirFor(platform(), homedir(), process.env);
}

/** Resolve discovery/sync path deps (same defaults as `detectClientConfigs`). */
export function resolveDetectClientConfigDeps(
  deps?: Partial<DetectClientConfigDeps>
): DetectClientConfigDeps {
  return {
    homedir: deps?.homedir ?? homedir,
    platform: deps?.platform ?? platform,
    env: deps?.env ?? process.env,
  };
}

export async function detectClientConfigs(
  cwd: string = process.cwd(),
  deps?: Partial<DetectClientConfigDeps>
): Promise<ClientConfig[]> {
  const resolved = resolveDetectClientConfigDeps(deps);
  const home = resolved.homedir();
  const osName = resolved.platform();
  const appData = getAppDataDirFor(osName, home, resolved.env);
  const configs: ClientConfig[] = [];

  // Cursor global
  const cursorGlobal = join(home, ".cursor", "mcp.json");
  if (await fileExists(cursorGlobal)) {
    configs.push({
      id: "cursor-global",
      name: "Cursor (global)",
      path: cursorGlobal,
      profile: "cursor",
      viewOnly: false,
    });
  }

  // Cursor project
  const cursorProject = join(cwd, ".cursor", "mcp.json");
  if (await fileExists(cursorProject)) {
    configs.push({
      id: "cursor-project",
      name: "Cursor (project)",
      path: cursorProject,
      profile: "cursor",
      viewOnly: false,
    });
  }

  // Claude Desktop
  const claudeDesktop = join(appData, "Claude", "claude_desktop_config.json");
  if (await fileExists(claudeDesktop)) {
    configs.push({
      id: "claude-desktop",
      name: "Claude Desktop",
      path: claudeDesktop,
      profile: "claude",
      viewOnly: false,
    });
  }

  // Claude Code global
  const claudeCodeGlobal = join(home, ".claude.json");
  if (await fileExists(claudeCodeGlobal)) {
    configs.push({
      id: "claude-code-global",
      name: "Claude Code (global)",
      path: claudeCodeGlobal,
      profile: "claude",
      viewOnly: false,
    });
  }

  // Claude Code project (same path as VS Code portable .mcp.json — shared mcpServers adapter)
  const claudeCodeProject = join(cwd, ".mcp.json");
  if (await fileExists(claudeCodeProject)) {
    configs.push({
      id: "claude-code-project",
      name: "Claude Code / VS Code portable (project .mcp.json)",
      path: claudeCodeProject,
      profile: "claude",
      viewOnly: false,
    });
  }

  // VS Code workspace
  const vscodeWorkspace = join(cwd, ".vscode", "mcp.json");
  if (await fileExists(vscodeWorkspace)) {
    configs.push({
      id: "vscode-workspace",
      name: "VS Code (workspace)",
      path: vscodeWorkspace,
      profile: "vscode",
      viewOnly: false,
    });
  }

  // VS Code user (check mcp.json first, then settings.json)
  const vscodeUserMcp = join(appData, "Code", "User", "mcp.json");
  if (await fileExists(vscodeUserMcp)) {
    configs.push({
      id: "vscode-user",
      name: "VS Code (user)",
      path: vscodeUserMcp,
      profile: "vscode",
      viewOnly: false,
    });
  } else {
    const vscodeUserSettings = join(appData, "Code", "User", "settings.json");
    if (await settingsJsonHasLegacyMcpServers(vscodeUserSettings)) {
      configs.push({
        id: "vscode-user",
        name: "VS Code (user, settings.json)",
        path: vscodeUserSettings,
        profile: "vscode",
        viewOnly: false,
      });
    }
  }

  // Windsurf (global only, uses .codeium not .windsurf)
  const windsurf = join(home, ".codeium", "windsurf", "mcp_config.json");
  if (await fileExists(windsurf)) {
    configs.push({
      id: "windsurf",
      name: "Windsurf (Devin)",
      path: windsurf,
      profile: "windsurf",
      viewOnly: false,
    });
  }

  // Antigravity global
  const antigravityGlobal = join(home, ".gemini", "config", "mcp_config.json");
  if (await fileExists(antigravityGlobal)) {
    configs.push({
      id: "antigravity-global",
      name: "Antigravity (global)",
      path: antigravityGlobal,
      profile: "antigravity",
      viewOnly: false,
    });
  }

  // Antigravity workspace
  const antigravityWorkspace = join(cwd, ".agents", "mcp_config.json");
  if (await fileExists(antigravityWorkspace)) {
    configs.push({
      id: "antigravity-workspace",
      name: "Antigravity (workspace)",
      path: antigravityWorkspace,
      profile: "antigravity",
      viewOnly: false,
    });
  }

  // Gemini CLI user
  const geminiUser = join(home, ".gemini", "settings.json");
  if (await fileExists(geminiUser)) {
    configs.push({
      id: "gemini-cli-user",
      name: "Gemini CLI (user)",
      path: geminiUser,
      profile: "gemini-settings",
      viewOnly: false,
    });
  }

  // Gemini CLI project
  const geminiProject = join(cwd, ".gemini", "settings.json");
  if (await fileExists(geminiProject)) {
    configs.push({
      id: "gemini-cli-project",
      name: "Gemini CLI (project)",
      path: geminiProject,
      profile: "gemini-settings",
      viewOnly: false,
    });
  }

  // OpenAI Codex CLI (user — $CODEX_HOME/config.toml, default ~/.codex/config.toml)
  const codexUser = join(getCodexHome(home, deps?.env ?? process.env), "config.toml");
  if (await fileExists(codexUser)) {
    configs.push({
      id: "codex",
      name: "OpenAI Codex CLI",
      path: codexUser,
      profile: "codex",
      viewOnly: false,
    });
  }

  // Codex project overrides (.codex/config.toml in repo)
  const codexProject = join(cwd, ".codex", "config.toml");
  if (await fileExists(codexProject)) {
    configs.push({
      id: "codex-project",
      name: "OpenAI Codex CLI (project)",
      path: codexProject,
      profile: "codex",
      viewOnly: false,
    });
  }

  // Copilot Agent Host (detect only — schema not verified for writes)
  const copilotMcp = join(home, ".copilot", "mcp-config.json");
  if (await fileExists(copilotMcp)) {
    configs.push({
      id: "copilot-agent-host",
      name: "Copilot Agent Host",
      path: copilotMcp,
      profile: null,
      viewOnly: true,
    });
  }

  return dedupeClientConfigsByPath(configs, osName);
}

/**
 * Get a client config by ID (never trust browser-supplied paths).
 */
export async function getClientConfigById(
  id: string,
  cwd: string = process.cwd(),
  deps?: Partial<DetectClientConfigDeps>
): Promise<ClientConfig | null> {
  const normalized = normalizeClientConfigId(id);
  const all = await detectClientConfigs(cwd, deps);
  return all.find((c) => c.id === normalized) || null;
}
