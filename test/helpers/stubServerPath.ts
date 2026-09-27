import path from "node:path";

/** Absolute path to the stub MCP server, safe to embed in JSON/TOML on all OSes. */
export function stubServerConfigPath(repoRoot: string): string {
  return path.join(repoRoot, "fixtures", "stub-mcp-server.mjs").replace(/\\/g, "/");
}

export function injectStubServerPath(content: string, repoRoot: string): string {
  return content.replace(/fixtures\/stub-mcp-server\.mjs/g, stubServerConfigPath(repoRoot));
}
