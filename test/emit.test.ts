import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Report, ToolMeter } from "../src/types.js";
import {
  selectHotTools,
  buildDeferHints,
  buildKeepProposal,
  writeArtifacts,
} from "../src/emit/writeArtifacts.js";
import { selectHotTools as selectHotFromKeep } from "../src/emit/keepHot.js";

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

describe("selectHotTools", () => {
  it("picks N lowest estTokens; ties broken by lex server+name", () => {
    const meters = [
      meter("b", "z", 10),
      meter("a", "y", 10),
      meter("a", "x", 50),
      meter("c", "w", 5),
    ];
    // From keepHot module (canonical)
    const hot = selectHotFromKeep(meters, 2);
    expect(hot.size).toBe(2);
    expect(hot.has("c::w")).toBe(true); // 5
    // tie at 10: a::y before b::z
    expect(hot.has("a::y")).toBe(true);
    expect(hot.has("b::z")).toBe(false);
  });

  it("re-export from writeArtifacts matches", () => {
    const meters = [meter("s", "a", 1), meter("s", "b", 99)];
    expect([...selectHotTools(meters, 1)]).toEqual(["s::a"]);
  });
});

describe("buildDeferHints", () => {
  it("marks hot as defer_loading false, rest true", () => {
    const meters = [meter("s", "cheap", 5), meter("s", "pricey", 100)];
    const hot = selectHotFromKeep(meters, 1);
    const hints = buildDeferHints(meters, hot) as {
      tools: Record<string, { defer_loading: boolean }>;
    };
    expect(hints.tools["s::cheap"].defer_loading).toBe(false);
    expect(hints.tools["s::pricey"].defer_loading).toBe(true);
  });
});

describe("writeArtifacts", () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), "sb-emit-"));
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("writes report.json, defer-hints.json, tool-token-budget.keep.json for both", async () => {
    const meters = [
      meter("demo", "a", 10),
      meter("demo", "b", 20),
      meter("demo", "c", 30),
    ];
    const report: Report = {
      generatedAt: "2026-09-23T00:00:00.000Z",
      tokenizerId: "o200k_base",
      totals: { estTokens: 60, toolCount: 3, serverCount: 1, findingCount: 0 },
      tools: meters,
      servers: [{ name: "demo", status: "ok" }],
      findings: [],
    };
    const written = await writeArtifacts(outDir, report, {
      keepHot: 2,
      format: "both",
    });
    expect(written.sort()).toEqual(
      [
        path.join(outDir, "report.json"),
        path.join(outDir, "defer-hints.json"),
        path.join(outDir, "tool-token-budget.keep.json"),
      ].sort()
    );
    const keep = JSON.parse(
      await readFile(path.join(outDir, "tool-token-budget.keep.json"), "utf8")
    );
    expect(keep.keepHot).toContain("demo::a");
    expect(keep.keepHot).toContain("demo::b");
    expect(keep.defer).toContain("demo::c");
  });
});
