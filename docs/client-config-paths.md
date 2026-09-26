# MCP Client Configuration Paths

This document provides the verified configuration file paths for various MCP clients across different operating systems. All paths have been verified against official documentation.

## Client Configuration Table

| Client | Scope | Windows | macOS | Linux | Schema Key | Writable | Source |
|--------|-------|---------|-------|-------|------------|----------|--------|
| **Cursor** | Global | `~/.cursor/mcp.json` | `~/.cursor/mcp.json` | `~/.cursor/mcp.json` | `mcpServers` | ✅ | [Cursor Docs](https://docs.cursor.com/advanced/mcp) |
| **Cursor** | Project | `.cursor/mcp.json` | `.cursor/mcp.json` | `.cursor/mcp.json` | `mcpServers` | ✅ | [Cursor Docs](https://docs.cursor.com/advanced/mcp) |
| **Claude Desktop** | Global | `%APPDATA%\Claude\claude_desktop_config.json` | `~/Library/Application Support/Claude/claude_desktop_config.json` | `~/.config/Claude/claude_desktop_config.json` | `mcpServers` | ✅ | [MCP Quickstart](https://modelcontextprotocol.io/quickstart/user), [Linux Beta](https://code.claude.com/docs/en/desktop-linux) |
| **Claude Code** | Global | `~/.claude.json` | `~/.claude.json` | `~/.claude.json` | `mcpServers` | ✅ | Claude Code extension docs |
| **Claude Code** | Project | `.mcp.json` | `.mcp.json` | `.mcp.json` | `mcpServers` | ✅ | Claude Code extension docs |
| **VS Code** | Workspace | `.vscode/mcp.json` | `.vscode/mcp.json` | `.vscode/mcp.json` | `servers` | ❌ View-only | [VS Code MCP Docs](https://code.visualstudio.com/docs/agent-customization/mcp-servers) |
| **VS Code** | User | `%APPDATA%\Code\User\mcp.json` | `~/Library/Application Support/Code/User/mcp.json` | `~/.config/Code/User/mcp.json` | `servers` | ❌ View-only | [VS Code MCP Docs](https://code.visualstudio.com/docs/agent-customization/mcp-servers) |
| **Windsurf** | Global | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` | `~/.codeium/windsurf/mcp_config.json` | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | ❌ View-only | [OneSource Docs](https://docs.onesource.io/getting-started/mcp/configure-windsurf), [StackMCP Guide](https://stackmcp.dev/blog/setup-mcp-servers-windsurf) |
| **Antigravity** | Global | `~/.gemini/config/mcp_config.json` | `~/.gemini/config/mcp_config.json` | `~/.gemini/config/mcp_config.json` | `mcpServers` | ❌ View-only | [Antigravity Docs](https://www.antigravity.google/docs/ide/mcp/) |
| **Antigravity** | Workspace | `.agents/mcp_config.json` | `.agents/mcp_config.json` | `.agents/mcp_config.json` | `mcpServers` | ❌ View-only | [Antigravity Docs](https://www.antigravity.google/docs/ide/mcp/) |
| **Gemini CLI** | User | `~/.gemini/settings.json` | `~/.gemini/settings.json` | `~/.gemini/settings.json` | `mcpServers` | ❌ View-only | [Gemini CLI Config Docs](https://github.com/google-gemini/gemini-cli/blob/HEAD/docs/reference/configuration.md) |
| **Gemini CLI** | Project | `.gemini/settings.json` | `.gemini/settings.json` | `.gemini/settings.json` | `mcpServers` | ❌ View-only | [Gemini CLI Config Docs](https://github.com/google-gemini/gemini-cli/blob/HEAD/docs/reference/configuration.md) |
| **OpenAI Codex CLI** | User | `%USERPROFILE%\.codex\config.toml` | `~/.codex/config.toml` | `~/.codex/config.toml` | `mcp_servers` (TOML) | ✅ | [Codex config reference](https://developers.openai.com/codex/config-reference), [Advanced config](https://developers.openai.com/codex/config-advanced) |
| **OpenAI Codex CLI** | Project | `.codex/config.toml` | `.codex/config.toml` | `.codex/config.toml` | `mcp_servers` (TOML) | ✅ | [Project `.codex/config.toml`](https://developers.openai.com/codex/config-advanced) |

## Schema Differences

### Standard Format (mcpServers)
Used by: Cursor, Claude Desktop, Claude Code, Windsurf, Antigravity, Gemini CLI

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "package-name"],
      "env": { "API_KEY": "value" }
    }
  }
}
```

### VS Code Format (servers)
Used by: VS Code

```json
{
  "servers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "package-name"],
      "env": { "API_KEY": "value" }
    }
  }
}
```

Or in `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "server-name": { ... }
    }
  }
}
```

### OpenAI Codex CLI Format (`mcp_servers` in TOML)
Used by: OpenAI Codex CLI (`--client codex` / `codex-project`). User file: `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`; set `CODEX_HOME` to relocate — directory must exist). Project overrides: `.codex/config.toml` (merged when the project is trusted). Disable a server with `enabled = false` on its table ([config reference](https://developers.openai.com/codex/config-reference)).

```toml
[mcp_servers.my-server]
command = "npx"
args = ["-y", "package-name"]

[mcp_servers.remote]
url = "https://example.com/mcp"
```

## Notes

### Linux Support Status
- **Claude Desktop**: Official Linux support in beta (Ubuntu 22.04+, Debian 12+) as of January 2025
- **VS Code, Windsurf, Antigravity, Gemini CLI**: Full Linux support
- **Cursor, Claude Code**: Cross-platform support

### View-Only Clients
Clients marked as "View-only" do not have emit profiles in Tool Token Budget and cannot export configurations:
- **VS Code**: Different schema structure (`servers` vs `mcpServers`)
- **Windsurf**: No emit profile implemented yet
- **Antigravity**: No emit profile implemented yet
- **Gemini CLI**: No emit profile implemented yet

### Windsurf Path Note
Windsurf uses `~/.codeium/windsurf/` (NOT `~/.windsurf/`) and the file is named `mcp_config.json` (NOT `mcp.json`). Only global configuration is supported; no project-level MCP files.

### VS Code Precedence
When both `.vscode/mcp.json` and `settings.json` contain MCP configuration, the workspace-level `.vscode/mcp.json` takes precedence.

## Verification Date
All paths and documentation sources verified: September 25, 2026
