import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeArtifacts } from "../src/emit/writeArtifacts.js";
import { loadToolsJson } from "../src/discover/fromToolsJson.js";
import { analyzeTools } from "../src/pipeline.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

describe("item 18: CLI apply requires valid adjacent report.json", () => {
  let cliPath: string;

  beforeAll(() => {
    cliPath = path.join(repoRoot, "dist", "cli.js");
  });

  async function setupEmitDir() {
    const testDir = await mkdtemp(path.join(tmpdir(), "item18-"));
    const mcpPath = path.join(testDir, "mcp.json");
    const outDir = path.join(testDir, "out");
    const config = {
      mcpServers: {
        tiny: { command: "node", args: ["tiny.js"] },
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    const { servers, tools } = await loadToolsJson(
      path.join(repoRoot, "fixtures", "tools-tiny.json")
    );
    const report = analyzeTools(tools, servers);
    await writeArtifacts(outDir, report, {
      format: "both",
      originalConfig: config,
      mcpConfigPath: mcpPath,
      policy: { keepPerServer: 1 },
    });
    return { testDir, mcpPath, outDir };
  }

  it("refuses live apply when report.json is missing and leaves config unchanged", async () => {
    const { testDir, mcpPath, outDir } = await setupEmitDir();
    const proposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");
    const reportPath = path.join(outDir, "report.json");
    const hashBefore = await sha256File(mcpPath);
    await rm(reportPath);

    let exitCode = 0;
    let output = "";
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

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/report\.json is missing/i);
    expect(await sha256File(mcpPath)).toBe(hashBefore);
    const outFiles = await readdir(outDir);
    expect(outFiles.filter((f) => f.includes(".bak"))).toHaveLength(0);

    await rm(testDir, { recursive: true, force: true });
  });

  it("refuses live apply when report.json is corrupt and leaves config unchanged", async () => {
    const { testDir, mcpPath, outDir } = await setupEmitDir();
    const proposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");
    const reportPath = path.join(outDir, "report.json");
    const hashBefore = await sha256File(mcpPath);
    await writeFile(reportPath, "{ not-json\n", "utf8");

    let exitCode = 0;
    let output = "";
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

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/report\.json is corrupt/i);
    expect(await sha256File(mcpPath)).toBe(hashBefore);

    await rm(testDir, { recursive: true, force: true });
  });

  it("refuses live apply when report.json is empty object (no sourceConfigHash)", async () => {
    const { testDir, mcpPath, outDir } = await setupEmitDir();
    const proposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");
    const reportPath = path.join(outDir, "report.json");
    const hashBefore = await sha256File(mcpPath);
    await writeFile(reportPath, "{}\n", "utf8");

    const result = await import("../src/apply/applyConfig.js").then((m) =>
      m.applyConfig({
        mcpConfigPath: mcpPath,
        proposedPath,
        dryRun: false,
        backup: true,
        yes: true,
      })
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sourceConfigHash/i);
    expect(await sha256File(mcpPath)).toBe(hashBefore);

    await rm(testDir, { recursive: true, force: true });
  });

  it("still refuses stale sourceConfigHash after config changes", async () => {
    const { testDir, mcpPath, outDir } = await setupEmitDir();
    const proposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");
    const hashBefore = await sha256File(mcpPath);
    await writeFile(
      mcpPath,
      JSON.stringify({ mcpServers: { changed: { command: "node", args: ["x.js"] } } }, null, 2) +
        "\n",
      "utf8"
    );

    let exitCode = 0;
    let output = "";
    try {
      execSync(
        `node "${cliPath}" apply --mcp-config "${mcpPath}" --proposed "${proposedPath}" --backup --yes 2>&1`,
        { cwd: repoRoot, encoding: "utf8" }
      );
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = e.status ?? 1;
      output = (e.stdout ?? "") + (e.stderr ?? "");
    }

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/hash mismatch/i);
    expect(await sha256File(mcpPath)).not.toBe(hashBefore);

    await rm(testDir, { recursive: true, force: true });
  });

  it("still refuses unexpected server removal when report does not allow it", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "item18-guard-"));
    const mcpPath = path.join(testDir, "mcp.json");
    const outDir = path.join(testDir, "out");
    await mkdir(outDir, { recursive: true });
    const config = {
      mcpServers: {
        local: { command: "node", args: ["a.js"] },
        remote: { url: "https://example.com/mcp" },
      },
    };
    await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    const meters = analyzeTools(
      [{ server: "local", name: "t", description: "d", inputSchema: { type: "object" } }],
      [{ name: "local", status: "ok" }, { name: "remote", status: "skipped_remote" }]
    );
    await writeArtifacts(outDir, meters, {
      format: "both",
      originalConfig: config,
      mcpConfigPath: mcpPath,
      policy: { keepPerServer: 1 },
    });
    const proposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");
    const bad = JSON.parse(await readFile(proposedPath, "utf8"));
    delete bad.mcpServers.remote;
    await writeFile(proposedPath, JSON.stringify(bad, null, 2) + "\n", "utf8");
    const hashBefore = await sha256File(mcpPath);

    const result = await import("../src/apply/applyConfig.js").then((m) =>
      m.applyConfig({
        mcpConfigPath: mcpPath,
        proposedPath,
        dryRun: false,
        backup: true,
        yes: true,
      })
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unexpectedly remove servers/i);
    expect(await sha256File(mcpPath)).toBe(hashBefore);

    await rm(testDir, { recursive: true, force: true });
  });
});
