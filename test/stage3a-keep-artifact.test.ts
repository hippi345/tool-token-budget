import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Report, ToolMeter } from "../src/types.js";
import {
  writeArtifacts,
  buildKeepProposal,
} from "../src/emit/writeArtifacts.js";
import {
  TOOL_TOKEN_BUDGET_KEEP_FILENAME,
  LEGACY_KEEP_FILENAME,
  readKeepProposalFromDir,
  keepProposalWritePath,
} from "../src/emit/keepArtifact.js";

function meter(server: string, name: string, est: number): ToolMeter {
  return {
    server,
    name,
    estTokens: est,
    breakdown: { name: 1, description: 1, schema: est - 2 },
    shareOfServer: 0,
    shareOfAll: 0,
  };
}

describe("stage3a keep artifact naming", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), "stage3a-keep-"));
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("stage3a-emit-writes-tool-token-budget-keep-json", async () => {
    const report: Report = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      tokenizerId: "o200k_base",
      totals: { estTokens: 10, toolCount: 1, serverCount: 1, findingCount: 0 },
      tools: [meter("s", "a", 10)],
      servers: [{ name: "s", status: "ok" }],
      findings: [],
    };
    await writeArtifacts(outDir, report, { format: "both", policy: { keepHot: 1 } });
    const keepPath = keepProposalWritePath(outDir);
    await readFile(keepPath, "utf8");
    expect(path.basename(keepPath)).toBe(TOOL_TOKEN_BUDGET_KEEP_FILENAME);
  });

  it("stage3a-read-legacy-schema-budget-keep-json", async () => {
    const legacyPath = path.join(outDir, LEGACY_KEEP_FILENAME);
    const payload = buildKeepProposal([meter("s", "a", 1)], new Set(["s::a"]));
    await writeFile(legacyPath, JSON.stringify(payload) + "\n", "utf8");
    const loaded = await readKeepProposalFromDir(outDir);
    expect(loaded?.filename).toBe(LEGACY_KEEP_FILENAME);
    expect(JSON.parse(loaded!.content).keepHot).toContain("s::a");
  });

  it("stage3a-read-prefers-new-over-legacy", async () => {
    await writeFile(
      path.join(outDir, LEGACY_KEEP_FILENAME),
      JSON.stringify({ version: 1, keepHot: ["legacy::only"], defer: [], byServer: {}, note: "" }) +
        "\n",
      "utf8"
    );
    await writeFile(
      path.join(outDir, TOOL_TOKEN_BUDGET_KEEP_FILENAME),
      JSON.stringify({ version: 1, keepHot: ["new::keep"], defer: [], byServer: {}, note: "" }) +
        "\n",
      "utf8"
    );
    const loaded = await readKeepProposalFromDir(outDir);
    expect(loaded?.filename).toBe(TOOL_TOKEN_BUDGET_KEEP_FILENAME);
    expect(JSON.parse(loaded!.content).keepHot).toContain("new::keep");
  });
});
