import { describe, it, expect } from "vitest";
import { shouldPassThroughUnmeteredServer } from "../src/mcp/configGuards.js";
import { buildProposedMcpConfig } from "../src/emit/writeArtifacts.js";
import { analyzeTools } from "../src/pipeline.js";
import { toolKey } from "../src/emit/keepHot.js";
import type { Report, Tool } from "../src/types.js";

describe("item 40: unanalyzed servers pass through", () => {
  it("shouldPassThroughUnmeteredServer returns true when server is absent from report", () => {
    const originalConfig = {
      mcpServers: {
        known: { command: "node", args: ["k.js"] },
        "late-added": { command: "node", args: ["late.js"] },
      },
    };
    const report: Report = analyzeTools(
      [
        {
          server: "known",
          name: "t1",
          description: "d",
          inputSchema: { type: "object" },
        },
      ],
      [{ name: "known", status: "ok" }]
    );

    expect(
      shouldPassThroughUnmeteredServer("late-added", originalConfig, report.tools, {
        report,
        discoveryInProgress: false,
      })
    ).toBe(true);

    expect(
      shouldPassThroughUnmeteredServer("known", originalConfig, report.tools, {
        report,
        discoveryInProgress: false,
      })
    ).toBe(false);
  });

  it("buildProposedMcpConfig keeps server missing from report and does not list as removed", () => {
    const originalConfig = {
      mcpServers: {
        small: { command: "node", args: ["s.js"] },
        big: { command: "node", args: ["b.js"] },
        "late-added": { command: "node", args: ["late.js"] },
      },
    };
    const tools: Tool[] = ["small", "big"].flatMap((server) => [
      {
        server,
        name: "t1",
        description: "x ".repeat(30),
        inputSchema: { type: "object", properties: { p: { type: "string" } } },
      },
      {
        server,
        name: "t2",
        description: "y ".repeat(30),
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
    const report = analyzeTools(tools, [
      { name: "small", status: "ok" },
      { name: "big", status: "ok" },
    ]);
    const hot = new Set([toolKey("small", "t1")]);
    const disabledServers = new Set<string>();

    const { proposed, allRemovedServers } = buildProposedMcpConfig(
      originalConfig,
      hot,
      disabledServers,
      report.tools,
      { report, discoveryInProgress: false }
    );

    const mcpServers = (proposed as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(mcpServers["late-added"]).toBeDefined();
    expect(allRemovedServers.has("late-added")).toBe(false);
    expect(allRemovedServers.has("big")).toBe(true);
  });
});
