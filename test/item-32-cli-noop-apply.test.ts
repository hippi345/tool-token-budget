import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeArtifacts } from "../src/emit/writeArtifacts.js";
import { analyzeTools } from "../src/pipeline.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("item 32: CLI no-op apply output", () => {
  let cliPath: string;

  beforeAll(() => {
    cliPath = path.join(repoRoot, "dist", "cli.js");
  });

  it("prints 'No changes; nothing written' for semantic no-op live apply", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "item32-"));
    const mcpPath = path.join(testDir, "mcp.json");
    const config = { mcpServers: { a: { command: "node", args: ["x.js"] } } };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    const report = analyzeTools(
      [{ server: "a", name: "t1", description: "d", inputSchema: { type: "object" } }],
      [{ name: "a", status: "ok" }]
    );
    const outDir = path.join(testDir, "out");
    await writeArtifacts(outDir, report, {
      format: "both",
      originalConfig: config,
      mcpConfigPath: mcpPath,
      policy: { keepPerServer: 5 },
    });

    const proposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");
    let output = "";
    let exitCode = 0;
    try {
      output = execSync(
        `node "${cliPath}" apply --mcp-config "${mcpPath}" --proposed "${proposedPath}" --backup --yes 2>&1`,
        { cwd: repoRoot, encoding: "utf8" }
      );
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = e.status ?? 1;
      output = (e.stdout ?? "") + (e.stderr ?? "");
    }

    expect(exitCode).toBe(0);
    expect(output).toContain("No changes; nothing written");
    expect(output).not.toMatch(/Applied:/);

    const after = await readFile(mcpPath, "utf8");
    expect(after).toBe(JSON.stringify(config, null, 2) + "\n");

    await rm(testDir, { recursive: true, force: true });
  });
});
