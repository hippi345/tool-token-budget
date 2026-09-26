import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeArtifacts } from "../src/emit/writeArtifacts.js";
import { analyzeTools } from "../src/pipeline.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("item 45: apply --yes requires --backup", () => {
  let cliPath: string;

  beforeAll(() => {
    cliPath = path.join(repoRoot, "dist", "cli.js");
  });

  it("prints apply --yes requires --backup and does not modify mcp.json", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "item45-"));
    const mcpPath = path.join(testDir, "mcp.json");
    const config = { mcpServers: { a: { command: "node", args: ["x.js"] } } };
    const body = JSON.stringify(config, null, 2) + "\n";
    await writeFile(mcpPath, body, "utf8");
    const hashBefore = createHash("sha256").update(body).digest("hex");

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
        `node "${cliPath}" apply --mcp-config "${mcpPath}" --proposed "${proposedPath}" --yes 2>&1`,
        { cwd: repoRoot, encoding: "utf8" }
      );
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = e.status ?? 1;
      output = (e.stdout ?? "") + (e.stderr ?? "");
    }

    expect(exitCode).not.toBe(0);
    expect(output).toContain("apply --yes requires --backup");
    expect(output).not.toContain("Cannot use --dry-run with --yes");
    const after = await readFile(mcpPath, "utf8");
    const hashAfter = createHash("sha256").update(after).digest("hex");
    expect(hashAfter).toBe(hashBefore);

    await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("allows apply --yes --dry-run without --backup and does not write", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "item45-dry-"));
    const mcpPath = path.join(testDir, "mcp.json");
    const config = { mcpServers: { a: { command: "node", args: ["x.js"] } } };
    const body = JSON.stringify(config, null, 2) + "\n";
    await writeFile(mcpPath, body, "utf8");
    const hashBefore = createHash("sha256").update(body).digest("hex");

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

    const output = execSync(
      `node "${cliPath}" apply --mcp-config "${mcpPath}" --proposed "${proposedPath}" --yes --dry-run 2>&1`,
      { cwd: repoRoot, encoding: "utf8" }
    );
    expect(output).toMatch(/Dry-run/i);
    const after = await readFile(mcpPath, "utf8");
    expect(createHash("sha256").update(after).digest("hex")).toBe(hashBefore);

    await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
});
