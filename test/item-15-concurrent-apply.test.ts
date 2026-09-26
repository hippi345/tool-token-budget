import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyConfig } from "../src/apply/applyConfig.js";
import { computeConfigContentHash } from "../src/mcp/configGuards.js";

describe("item 15: concurrent CLI apply lock and hash check", () => {
  let testDir: string;
  let mcpPath: string;
  let proposedPath: string;
  let originalBytes: string;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "item15-"));
    mcpPath = path.join(testDir, "mcp.json");
    proposedPath = path.join(testDir, "mcp.json.tool-token-budget-proposed.json");

    const original = {
      mcpServers: {
        s1: { command: "node", args: ["a.js"] },
        s2: { command: "node", args: ["b.js"] },
      },
    };
    originalBytes = JSON.stringify(original, null, 2) + "\n";
    await writeFile(mcpPath, originalBytes, "utf8");

    const proposed = {
      mcpServers: {
        s1: { command: "node", args: ["a.js"] },
      },
    };
    await writeFile(proposedPath, JSON.stringify(proposed, null, 2) + "\n", "utf8");

    const hash = computeConfigContentHash(originalBytes);
    await writeFile(
      path.join(testDir, "report.json"),
      JSON.stringify(
        {
          savings: { removedServers: ["s2"] },
          sourceConfigHash: hash,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("exactly one concurrent apply succeeds; others fail with lock or hash error", async () => {
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        applyConfig({
          mcpConfigPath: mcpPath,
          proposedPath,
          dryRun: false,
          backup: true,
          yes: true,
        })
      )
    );

    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(2);
    for (const f of failures) {
      expect(f.error).toMatch(/lock|hash mismatch|changed since/i);
    }

    const finalContent = await readFile(mcpPath, "utf8");
    expect(JSON.parse(finalContent).mcpServers.s2).toBeUndefined();

    const files = await readdir(testDir);
    const backups = files.filter((f) => f.includes(".bak-"));
    expect(backups).toHaveLength(1);
    const backupContent = await readFile(path.join(testDir, backups[0]), "utf8");
    expect(backupContent).toBe(originalBytes);
  });
});
