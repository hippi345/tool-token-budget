import type { ToolMeter, PolicyOptions } from "../types.js";

/** Key for tool identity in emit artifacts. */
export function toolKey(server: string, name: string): string {
  return `${server}::${name}`;
}

/**
 * Select N lowest estTokens tools as hot.
 * Ties: lexicographic server+name ascending.
 */
export function selectHotTools(meters: ToolMeter[], n: number): Set<string> {
  const sorted = [...meters].sort((a, b) => {
    if (a.estTokens !== b.estTokens) return a.estTokens - b.estTokens;
    const ka = toolKey(a.server, a.name);
    const kb = toolKey(b.server, b.name);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const hot = new Set<string>();
  for (const m of sorted.slice(0, Math.max(0, n))) {
    hot.add(toolKey(m.server, m.name));
  }
  return hot;
}

/**
 * Select hot tools with advanced policy support:
 * - keepHot: global N lowest token tools
 * - keepPerServer: up to N cheapest tools per server
 * - disableServersOver: mark entire servers as disabled if total > threshold
 */
export function selectHotToolsWithPolicy(
  meters: ToolMeter[],
  policy: PolicyOptions
): { hot: Set<string>; disabledServers: Set<string> } {
  const hot = new Set<string>();
  const disabledServers = new Set<string>();

  // First, check for servers to disable based on total cost
  if (policy.disableServersOver !== undefined) {
    const serverTotals = new Map<string, number>();
    for (const m of meters) {
      serverTotals.set(m.server, (serverTotals.get(m.server) || 0) + m.estTokens);
    }
    for (const [server, total] of serverTotals) {
      if (total > policy.disableServersOver) {
        disabledServers.add(server);
      }
    }
  }

  // Filter out tools from disabled servers
  const enabledMeters = meters.filter(m => !disabledServers.has(m.server));

  // Apply keep-per-server policy
  if (policy.keepPerServer !== undefined && policy.keepPerServer > 0) {
    const byServer = new Map<string, ToolMeter[]>();
    for (const m of enabledMeters) {
      if (!byServer.has(m.server)) {
        byServer.set(m.server, []);
      }
      byServer.get(m.server)!.push(m);
    }
    
    for (const [, serverMeters] of byServer) {
      const sorted = [...serverMeters].sort((a, b) => {
        if (a.estTokens !== b.estTokens) return a.estTokens - b.estTokens;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
      for (const m of sorted.slice(0, policy.keepPerServer)) {
        hot.add(toolKey(m.server, m.name));
      }
    }
  }

  // Apply global keep-hot policy (additive with keep-per-server)
  if (policy.keepHot !== undefined && policy.keepHot > 0) {
    const globalHot = selectHotTools(enabledMeters, policy.keepHot);
    for (const key of globalHot) {
      hot.add(key);
    }
  }

  return { hot, disabledServers };
}
