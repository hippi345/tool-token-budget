/**
 * Parse MCP tool names from client logs into server + tool.
 * Claude Code / Cursor use `mcp__<server>__<tool>` (documented convention).
 */
export function parseMcpToolName(rawName: string): { server: string; tool: string } | null {
  const name = rawName.trim();
  if (!name.startsWith("mcp__")) {
    return null;
  }
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep >= rest.length - 2) {
    return null;
  }
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) {
    return null;
  }
  return { server, tool };
}

export function usageCountKey(server: string, tool: string): string {
  return `${server}::${tool}`;
}
