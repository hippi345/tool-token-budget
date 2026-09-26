import type { Server, Tool, Report } from "../types.js";

export interface Snapshot {
  timestamp: string;
  servers: Server[];
  tools: Tool[];
  report: Report;
}

export interface ServerDiff {
  added: string[];
  removed: string[];
  statusChanged: Array<{ name: string; oldStatus: string; newStatus: string }>;
}

export interface ToolDiff {
  added: Array<{ server: string; name: string; estTokens: number }>;
  removed: Array<{ server: string; name: string; estTokens: number }>;
  changed: Array<{
    server: string;
    name: string;
    oldEstTokens: number;
    newEstTokens: number;
    delta: number;
  }>;
}

export interface TokenDelta {
  total: number;
  perServer: Map<string, number>;
}

export interface Diff {
  servers: ServerDiff;
  tools: ToolDiff;
  tokens: TokenDelta;
}

export function diffSnapshots(prev: Snapshot | null, current: Snapshot): Diff | null {
  if (!prev) return null;

  const diff: Diff = {
    servers: diffServers(prev.servers, current.servers),
    tools: diffTools(prev.report, current.report),
    tokens: {
      total: current.report.totals.estTokens - prev.report.totals.estTokens,
      perServer: new Map(),
    },
  };

  // Calculate per-server token deltas
  const prevByServer = new Map<string, number>();
  for (const tool of prev.report.tools) {
    prevByServer.set(tool.server, (prevByServer.get(tool.server) || 0) + tool.estTokens);
  }

  const currByServer = new Map<string, number>();
  for (const tool of current.report.tools) {
    currByServer.set(tool.server, (currByServer.get(tool.server) || 0) + tool.estTokens);
  }

  const allServers = new Set([...prevByServer.keys(), ...currByServer.keys()]);
  for (const server of allServers) {
    const prevTokens = prevByServer.get(server) || 0;
    const currTokens = currByServer.get(server) || 0;
    const delta = currTokens - prevTokens;
    if (delta !== 0) {
      diff.tokens.perServer.set(server, delta);
    }
  }

  // Return null if nothing changed
  if (
    diff.servers.added.length === 0 &&
    diff.servers.removed.length === 0 &&
    diff.servers.statusChanged.length === 0 &&
    diff.tools.added.length === 0 &&
    diff.tools.removed.length === 0 &&
    diff.tools.changed.length === 0 &&
    diff.tokens.total === 0
  ) {
    return null;
  }

  return diff;
}

function diffServers(prev: Server[], current: Server[]): ServerDiff {
  const prevNames = new Set(prev.map((s) => s.name));
  const currNames = new Set(current.map((s) => s.name));

  const added = current.filter((s) => !prevNames.has(s.name)).map((s) => s.name);
  const removed = prev.filter((s) => !currNames.has(s.name)).map((s) => s.name);

  const prevByName = new Map(prev.map((s) => [s.name, s]));
  const currByName = new Map(current.map((s) => [s.name, s]));

  const statusChanged: Array<{ name: string; oldStatus: string; newStatus: string }> = [];
  for (const name of prevNames) {
    if (currNames.has(name)) {
      const prevServer = prevByName.get(name)!;
      const currServer = currByName.get(name)!;
      if (prevServer.status !== currServer.status) {
        statusChanged.push({
          name,
          oldStatus: prevServer.status,
          newStatus: currServer.status,
        });
      }
    }
  }

  return { added, removed, statusChanged };
}

function diffTools(prevReport: Report, currentReport: Report): ToolDiff {
  const prevTools = new Map(
    prevReport.tools.map((t) => [`${t.server}::${t.name}`, t])
  );
  const currTools = new Map(
    currentReport.tools.map((t) => [`${t.server}::${t.name}`, t])
  );

  const added: ToolDiff["added"] = [];
  const removed: ToolDiff["removed"] = [];
  const changed: ToolDiff["changed"] = [];

  for (const [key, tool] of currTools) {
    if (!prevTools.has(key)) {
      added.push({
        server: tool.server,
        name: tool.name,
        estTokens: tool.estTokens,
      });
    }
  }

  for (const [key, tool] of prevTools) {
    if (!currTools.has(key)) {
      removed.push({
        server: tool.server,
        name: tool.name,
        estTokens: tool.estTokens,
      });
    } else {
      const curr = currTools.get(key)!;
      if (curr.estTokens !== tool.estTokens) {
        changed.push({
          server: tool.server,
          name: tool.name,
          oldEstTokens: tool.estTokens,
          newEstTokens: curr.estTokens,
          delta: curr.estTokens - tool.estTokens,
        });
      }
    }
  }

  return { added, removed, changed };
}

export function formatDiff(diff: Diff): string {
  const lines: string[] = [];

  if (diff.servers.added.length > 0) {
    lines.push(`Servers added: ${diff.servers.added.join(", ")}`);
  }
  if (diff.servers.removed.length > 0) {
    lines.push(`Servers removed: ${diff.servers.removed.join(", ")}`);
  }
  if (diff.servers.statusChanged.length > 0) {
    for (const s of diff.servers.statusChanged) {
      lines.push(`Server ${s.name}: ${s.oldStatus} → ${s.newStatus}`);
    }
  }

  if (diff.tools.added.length > 0) {
    lines.push(`Tools added: ${diff.tools.added.length} (+${diff.tools.added.reduce((sum, t) => sum + t.estTokens, 0)} tokens)`);
  }
  if (diff.tools.removed.length > 0) {
    lines.push(`Tools removed: ${diff.tools.removed.length} (-${diff.tools.removed.reduce((sum, t) => sum + t.estTokens, 0)} tokens)`);
  }
  if (diff.tools.changed.length > 0) {
    lines.push(`Tools changed: ${diff.tools.changed.length}`);
  }

  const tokenDelta = diff.tokens.total;
  if (tokenDelta !== 0) {
    const sign = tokenDelta > 0 ? "+" : "";
    lines.push(`Total tokens: ${sign}${tokenDelta}`);
  }

  for (const [server, delta] of diff.tokens.perServer) {
    const sign = delta > 0 ? "+" : "";
    lines.push(`  ${server}: ${sign}${delta} tokens`);
  }

  return lines.join("\n");
}
