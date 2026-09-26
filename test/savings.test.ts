import { describe, it, expect } from "vitest";
import type { ToolMeter } from "../src/types.js";
import { calculateSavings, buildProposedMcpConfig } from "../src/emit/writeArtifacts.js";
import { selectHotToolsWithPolicy, toolKey } from "../src/emit/keepHot.js";

function meter(
  server: string,
  name: string,
  estTokens: number
): ToolMeter {
  return {
    server,
    name,
    estTokens,
    breakdown: { name: 1, description: 1, schema: estTokens - 2 },
    shareOfServer: 0,
    shareOfAll: 0,
  };
}

describe("calculateSavings", () => {
  it("calculates savings correctly", () => {
    const meters = [
      meter("s1", "a", 100),
      meter("s1", "b", 200),
      meter("s1", "c", 300),
    ];
    const hot = new Set([toolKey("s1", "a"), toolKey("s1", "b")]);
    const disabledServers = new Set<string>();

    const savings = calculateSavings(meters, hot, disabledServers);

    expect(savings.currentEstTokens).toBe(600);
    expect(savings.proposedEstTokens).toBe(300); // a + b
    expect(savings.savedEstTokens).toBe(300);
    expect(savings.savedPct).toBe(50);
  });

  it("handles disabled servers in savings", () => {
    const meters = [
      meter("s1", "a", 100),
      meter("s2", "b", 200),
      meter("s3", "c", 300),
    ];
    const hot = new Set([toolKey("s1", "a"), toolKey("s2", "b"), toolKey("s3", "c")]);
    const disabledServers = new Set(["s2", "s3"]);

    const savings = calculateSavings(meters, hot, disabledServers);

    expect(savings.currentEstTokens).toBe(600);
    expect(savings.proposedEstTokens).toBe(100); // only s1::a
    expect(savings.savedEstTokens).toBe(500);
    expect(savings.savedPct).toBe(83.33);
  });

  it("handles zero current tokens", () => {
    const meters: ToolMeter[] = [];
    const hot = new Set<string>();
    const disabledServers = new Set<string>();

    const savings = calculateSavings(meters, hot, disabledServers);

    expect(savings.currentEstTokens).toBe(0);
    expect(savings.proposedEstTokens).toBe(0);
    expect(savings.savedEstTokens).toBe(0);
    expect(savings.savedPct).toBe(0);
  });
});

describe("selectHotToolsWithPolicy", () => {
  it("applies keep-per-server policy", () => {
    const meters = [
      meter("s1", "a", 10),
      meter("s1", "b", 20),
      meter("s1", "c", 30),
      meter("s2", "d", 5),
      meter("s2", "e", 15),
      meter("s2", "f", 25),
    ];

    const { hot, disabledServers } = selectHotToolsWithPolicy(meters, {
      keepPerServer: 2,
    });

    // Should keep 2 cheapest from each server
    expect(hot.has(toolKey("s1", "a"))).toBe(true);
    expect(hot.has(toolKey("s1", "b"))).toBe(true);
    expect(hot.has(toolKey("s1", "c"))).toBe(false);
    expect(hot.has(toolKey("s2", "d"))).toBe(true);
    expect(hot.has(toolKey("s2", "e"))).toBe(true);
    expect(hot.has(toolKey("s2", "f"))).toBe(false);
    expect(disabledServers.size).toBe(0);
  });

  it("applies disable-servers-over policy", () => {
    const meters = [
      meter("cheap", "a", 10),
      meter("cheap", "b", 20),
      meter("expensive", "c", 500),
      meter("expensive", "d", 600),
    ];

    const { hot, disabledServers } = selectHotToolsWithPolicy(meters, {
      keepHot: 10,
      disableServersOver: 100,
    });

    // Expensive server should be disabled (total 1100 > 100)
    expect(disabledServers.has("expensive")).toBe(true);
    expect(disabledServers.has("cheap")).toBe(false);

    // Hot tools should only be from cheap server
    expect(hot.has(toolKey("cheap", "a"))).toBe(true);
    expect(hot.has(toolKey("cheap", "b"))).toBe(true);
    expect(hot.has(toolKey("expensive", "c"))).toBe(false);
    expect(hot.has(toolKey("expensive", "d"))).toBe(false);
  });

  it("combines keep-hot and keep-per-server policies", () => {
    const meters = [
      meter("s1", "a", 5),
      meter("s1", "b", 10),
      meter("s2", "c", 15),
      meter("s2", "d", 20),
    ];

    const { hot } = selectHotToolsWithPolicy(meters, {
      keepHot: 1,
      keepPerServer: 1,
    });

    // keep-hot selects 1 cheapest globally (s1::a)
    // keep-per-server adds 1 from each server (s1::a, s2::c)
    // Result: union of both policies
    expect(hot.has(toolKey("s1", "a"))).toBe(true);
    expect(hot.has(toolKey("s2", "c"))).toBe(true);
    expect(hot.size).toBe(2);
  });
});

describe("buildProposedMcpConfig", () => {
  it("builds proposed config with only hot servers", () => {
    const originalConfig = {
      mcpServers: {
        keep: { command: "node", args: ["keep.js"] },
        remove: { command: "node", args: ["remove.js"] },
      },
    };

    const meters = [
      meter("keep", "a", 10),
      meter("remove", "b", 20),
    ];

    const hot = new Set([toolKey("keep", "a")]);
    const disabledServers = new Set<string>();

    const { proposed, allRemovedServers } = buildProposedMcpConfig(originalConfig, hot, disabledServers, meters);

    expect(proposed).toHaveProperty("mcpServers");
    const mcpServers = (proposed as any).mcpServers;
    expect(mcpServers.keep).toBeDefined();
    expect(mcpServers.remove).toBeUndefined();
    expect(allRemovedServers.has("remove")).toBe(true);
    expect(allRemovedServers.size).toBe(1);
  });

  it("excludes disabled servers from proposed config", () => {
    const originalConfig = {
      mcpServers: {
        enabled: { command: "node", args: ["enabled.js"] },
        disabled: { command: "node", args: ["disabled.js"] },
      },
    };

    const meters = [
      meter("enabled", "a", 10),
      meter("disabled", "b", 20),
    ];

    const hot = new Set([toolKey("enabled", "a"), toolKey("disabled", "b")]);
    const disabledServers = new Set(["disabled"]);

    const { proposed, allRemovedServers } = buildProposedMcpConfig(originalConfig, hot, disabledServers, meters);

    const mcpServers = (proposed as any).mcpServers;
    expect(mcpServers.enabled).toBeDefined();
    expect(mcpServers.disabled).toBeUndefined();
    expect(allRemovedServers.has("disabled")).toBe(true);
    expect(allRemovedServers.size).toBe(1);
  });

  it("handles empty original config", () => {
    const originalConfig = null;
    const meters: ToolMeter[] = [];
    const hot = new Set<string>();
    const disabledServers = new Set<string>();

    const { proposed, allRemovedServers } = buildProposedMcpConfig(originalConfig, hot, disabledServers, meters);

    expect(proposed).toHaveProperty("mcpServers");
    expect((proposed as any).mcpServers).toEqual({});
    expect(allRemovedServers.size).toBe(0);
  });
});
