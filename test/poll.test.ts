import { describe, test, expect, vi } from "vitest";
import { diffSnapshots, formatDiff, type Snapshot } from "../src/poll/differ.js";
import { Poller } from "../src/poll/poller.js";
import type { Report, Server, Tool } from "../src/types.js";

function makeSnapshot(
  servers: Server[],
  tools: Tool[],
  totals: { estTokens: number; toolCount: number }
): Snapshot {
  const report: Report = {
    generatedAt: new Date().toISOString(),
    tokenizerId: "o200k_base",
    totals: {
      estTokens: totals.estTokens,
      toolCount: totals.toolCount,
      serverCount: servers.length,
      findingCount: 0,
    },
    tools: tools.map((t) => ({
      server: t.server,
      name: t.name,
      estTokens: 100,
      breakdown: { name: 10, description: 30, schema: 60 },
      shareOfServer: 0.5,
      shareOfAll: 0.1,
    })),
    servers,
    findings: [],
  };
  return { timestamp: new Date().toISOString(), servers, tools, report };
}

describe("poll differ", () => {
  test("returns null for first snapshot", () => {
    const snapshot = makeSnapshot(
      [{ name: "test", status: "ok" }],
      [{ server: "test", name: "tool1", description: "desc", inputSchema: {} }],
      { estTokens: 100, toolCount: 1 }
    );
    const diff = diffSnapshots(null, snapshot);
    expect(diff).toBeNull();
  });

  test("returns null when nothing changed", () => {
    const prev = makeSnapshot(
      [{ name: "test", status: "ok" }],
      [{ server: "test", name: "tool1", description: "desc", inputSchema: {} }],
      { estTokens: 100, toolCount: 1 }
    );
    const curr = makeSnapshot(
      [{ name: "test", status: "ok" }],
      [{ server: "test", name: "tool1", description: "desc", inputSchema: {} }],
      { estTokens: 100, toolCount: 1 }
    );
    const diff = diffSnapshots(prev, curr);
    expect(diff).toBeNull();
  });

  test("detects added servers", () => {
    const prev = makeSnapshot([{ name: "s1", status: "ok" }], [], { estTokens: 0, toolCount: 0 });
    const curr = makeSnapshot(
      [
        { name: "s1", status: "ok" },
        { name: "s2", status: "ok" },
      ],
      [],
      { estTokens: 0, toolCount: 0 }
    );
    const diff = diffSnapshots(prev, curr);
    expect(diff).not.toBeNull();
    expect(diff!.servers.added).toEqual(["s2"]);
    expect(diff!.servers.removed).toEqual([]);
  });

  test("detects removed servers", () => {
    const prev = makeSnapshot(
      [
        { name: "s1", status: "ok" },
        { name: "s2", status: "ok" },
      ],
      [],
      { estTokens: 0, toolCount: 0 }
    );
    const curr = makeSnapshot([{ name: "s1", status: "ok" }], [], { estTokens: 0, toolCount: 0 });
    const diff = diffSnapshots(prev, curr);
    expect(diff).not.toBeNull();
    expect(diff!.servers.removed).toEqual(["s2"]);
    expect(diff!.servers.added).toEqual([]);
  });

  test("detects server status changes", () => {
    const prev = makeSnapshot([{ name: "s1", status: "ok" }], [], { estTokens: 0, toolCount: 0 });
    const curr = makeSnapshot([{ name: "s1", status: "timed_out" }], [], { estTokens: 0, toolCount: 0 });
    const diff = diffSnapshots(prev, curr);
    expect(diff).not.toBeNull();
    expect(diff!.servers.statusChanged).toEqual([
      { name: "s1", oldStatus: "ok", newStatus: "timed_out" },
    ]);
  });

  test("detects added tools", () => {
    const prev = makeSnapshot(
      [{ name: "s1", status: "ok" }],
      [{ server: "s1", name: "t1", description: "d", inputSchema: {} }],
      { estTokens: 100, toolCount: 1 }
    );
    const curr = makeSnapshot(
      [{ name: "s1", status: "ok" }],
      [
        { server: "s1", name: "t1", description: "d", inputSchema: {} },
        { server: "s1", name: "t2", description: "d", inputSchema: {} },
      ],
      { estTokens: 200, toolCount: 2 }
    );
    const diff = diffSnapshots(prev, curr);
    expect(diff).not.toBeNull();
    expect(diff!.tools.added.length).toBe(1);
    expect(diff!.tools.added[0].name).toBe("t2");
  });

  test("detects removed tools", () => {
    const prev = makeSnapshot(
      [{ name: "s1", status: "ok" }],
      [
        { server: "s1", name: "t1", description: "d", inputSchema: {} },
        { server: "s1", name: "t2", description: "d", inputSchema: {} },
      ],
      { estTokens: 200, toolCount: 2 }
    );
    const curr = makeSnapshot(
      [{ name: "s1", status: "ok" }],
      [{ server: "s1", name: "t1", description: "d", inputSchema: {} }],
      { estTokens: 100, toolCount: 1 }
    );
    const diff = diffSnapshots(prev, curr);
    expect(diff).not.toBeNull();
    expect(diff!.tools.removed.length).toBe(1);
    expect(diff!.tools.removed[0].name).toBe("t2");
  });

  test("calculates token deltas", () => {
    const prev = makeSnapshot(
      [{ name: "s1", status: "ok" }],
      [{ server: "s1", name: "t1", description: "d", inputSchema: {} }],
      { estTokens: 100, toolCount: 1 }
    );
    const curr = makeSnapshot(
      [{ name: "s1", status: "ok" }],
      [
        { server: "s1", name: "t1", description: "d", inputSchema: {} },
        { server: "s1", name: "t2", description: "d", inputSchema: {} },
      ],
      { estTokens: 200, toolCount: 2 }
    );
    const diff = diffSnapshots(prev, curr);
    expect(diff).not.toBeNull();
    expect(diff!.tokens.total).toBe(100);
    expect(diff!.tokens.perServer.get("s1")).toBe(100);
  });

  test("formatDiff produces readable output", () => {
    const prev = makeSnapshot([{ name: "s1", status: "ok" }], [], { estTokens: 0, toolCount: 0 });
    const curr = makeSnapshot(
      [
        { name: "s1", status: "ok" },
        { name: "s2", status: "ok" },
      ],
      [{ server: "s2", name: "t1", description: "d", inputSchema: {} }],
      { estTokens: 100, toolCount: 1 }
    );
    const diff = diffSnapshots(prev, curr);
    expect(diff).not.toBeNull();
    const formatted = formatDiff(diff!);
    expect(formatted).toContain("Servers added: s2");
    expect(formatted).toContain("Total tokens: +100");
  });

  test("schedules ticks from start time, skips overlapping ticks (Item 4)", async () => {
    // Test with real time but very short intervals to verify behavior
    const tickTimes: number[] = [];
    let slowPollResolve: (() => void) | null = null;
    let pollInProgress = false;
    
    const poller = new Poller({
      intervalSec: 0.05, // 50ms interval for fast test
      discover: async () => {
        if (pollInProgress) {
          throw new Error("Overlap detected - test failed!");
        }
        pollInProgress = true;
        
        const tickStart = Date.now();
        tickTimes.push(tickStart);
        
        // Third tick blocks
        if (tickTimes.length === 3) {
          await new Promise<void>(resolve => {
            slowPollResolve = resolve;
          });
        }
        
        pollInProgress = false;
        return { servers: [], tools: [] };
      },
      analyze: () => ({ estTokens: 0, toolCount: 0 }),
      onSnapshot: () => {},
      onError: () => {},
    });
    
    try {
      await poller.start();
      
      // Wait for first tick
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(tickTimes.length).toBeGreaterThanOrEqual(1);
      
      // Wait for second tick
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(tickTimes.length).toBeGreaterThanOrEqual(2);
      
      // Wait for third tick to start (and block)
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(tickTimes.length).toBe(3);
      expect(slowPollResolve).not.toBeNull();
      
      // Wait for what would be the fourth tick time
      // But it should NOT fire because third is still running
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(tickTimes.length).toBe(3); // Still only 3
      
      // Now resolve the third tick
      slowPollResolve!();
      
      // Wait a bit for fourth tick to fire
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(tickTimes.length).toBeGreaterThanOrEqual(4);
      
      // Verify timing: ticks should be roughly intervalSec apart (when not blocked)
      const t1 = tickTimes[0];
      const t2 = tickTimes[1];
      const interval = t2 - t1;
      expect(interval).toBeGreaterThanOrEqual(40); // ~50ms with some tolerance
      expect(interval).toBeLessThan(100);
    } finally {
      poller.stop();
    }
  });
});
