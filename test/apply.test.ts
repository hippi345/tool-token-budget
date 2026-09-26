import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyConfig } from "../src/apply/applyConfig.js";
import { writeAdjacentEmitReport } from "./apply-report-helper.js";

describe("applyConfig", () => {
  let testDir: string;
  let mcpConfigPath: string;
  let proposedPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(path.join(tmpdir(), "sb-apply-"));
    mcpConfigPath = path.join(testDir, "mcp.json");
    proposedPath = path.join(testDir, "mcp.json.tool-token-budget-proposed.json");

    // Create a sample original config
    const originalConfig = {
      mcpServers: {
        server1: { command: "node", args: ["test1.js"] },
        server2: { command: "node", args: ["test2.js"] },
        server3: { command: "node", args: ["test3.js"] },
      },
    };
    await writeFile(mcpConfigPath, JSON.stringify(originalConfig, null, 2), "utf8");

    // Create a sample proposed config with one server removed
    const proposedConfig = {
      mcpServers: {
        server1: { command: "node", args: ["test1.js"] },
        server2: { command: "node", args: ["test2.js"] },
      },
    };
    await writeFile(proposedPath, JSON.stringify(proposedConfig, null, 2), "utf8");
    await writeAdjacentEmitReport(proposedPath, mcpConfigPath, ["server3"]);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("dry-run shows diff summary without writing", async () => {
    const result = await applyConfig({
      mcpConfigPath,
      proposedPath,
      dryRun: true,
      backup: false,
      yes: false,
    });

    expect(result.success).toBe(true);
    expect(result.diffSummary).toBeDefined();
    expect(result.diffSummary!.totalBefore).toBe(3);
    expect(result.diffSummary!.totalAfter).toBe(2);
    expect(result.diffSummary!.serversRemoved).toContain("server3");
    expect(result.diffSummary!.serversKept).toContain("server1");
    expect(result.diffSummary!.serversKept).toContain("server2");

    // Original file should be unchanged
    const stillOriginal = JSON.parse(await readFile(mcpConfigPath, "utf8"));
    expect(Object.keys(stillOriginal.mcpServers)).toHaveLength(3);
  });

  it("refuses to apply without backup and yes flags", async () => {
    const result = await applyConfig({
      mcpConfigPath,
      proposedPath,
      dryRun: false,
      backup: false,
      yes: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("requires both --backup and --yes");
  });

  it("refuses to apply with backup but no yes", async () => {
    const result = await applyConfig({
      mcpConfigPath,
      proposedPath,
      dryRun: false,
      backup: true,
      yes: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("requires both --backup and --yes");
  });

  it("creates backup and applies with backup and yes", async () => {
    const result = await applyConfig({
      mcpConfigPath,
      proposedPath,
      dryRun: false,
      backup: true,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).toMatch(/\.bak-/);

    // Backup file should exist with original content
    const backupContent = JSON.parse(await readFile(result.backupPath!, "utf8"));
    expect(Object.keys(backupContent.mcpServers)).toHaveLength(3);

    // Original file should now have the proposed content
    const newContent = JSON.parse(await readFile(mcpConfigPath, "utf8"));
    expect(Object.keys(newContent.mcpServers)).toHaveLength(2);
    expect(newContent.mcpServers.server1).toBeDefined();
    expect(newContent.mcpServers.server2).toBeDefined();
    expect(newContent.mcpServers.server3).toBeUndefined();
  });

  it("fails gracefully if proposed file missing", async () => {
    const result = await applyConfig({
      mcpConfigPath,
      proposedPath: path.join(testDir, "nonexistent.json"),
      dryRun: false,
      backup: true,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("fails gracefully if proposed file has invalid JSON", async () => {
    await writeFile(proposedPath, "{ invalid json }", "utf8");

    const result = await applyConfig({
      mcpConfigPath,
      proposedPath,
      dryRun: false,
      backup: true,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("parse");
  });

  it("MUST 3: two back-to-back applies create distinct backups with local-time ms+random names", async () => {
    // Prepare original config
    const testOriginalConfig = {
      mcpServers: {
        server1: { command: "node", args: ["s1.js"] },
        server2: { command: "node", args: ["s2.js"] },
      },
    };
    await writeFile(mcpConfigPath, JSON.stringify(testOriginalConfig, null, 2), "utf8");
    const originalBytes = await readFile(mcpConfigPath, "utf8");

    // Create two different proposed configs
    const proposed1 = { ...testOriginalConfig, version: 1 };
    const proposed1Path = path.join(testDir, "proposed1.json");
    await writeFile(proposed1Path, JSON.stringify(proposed1, null, 2), "utf8");
    await writeAdjacentEmitReport(proposed1Path, mcpConfigPath, []);

    const proposed2 = { ...testOriginalConfig, version: 2 };
    const proposed2Path = path.join(testDir, "proposed2.json");
    await writeFile(proposed2Path, JSON.stringify(proposed2, null, 2), "utf8");

    // Apply first - immediately get backup path
    const result1 = await applyConfig({
      mcpConfigPath,
      proposedPath: proposed1Path,
      dryRun: false,
      backup: true,
      yes: true,
    });

    expect(result1.success).toBe(true);
    expect(result1.backupPath).toBeDefined();
    const backup1Path = result1.backupPath!;
    expect(existsSync(backup1Path)).toBe(true);

    // Verify backup1 equals original
    const backup1Content = await readFile(backup1Path, "utf8");
    expect(backup1Content).toBe(originalBytes);

    // Verify backup name has local-time format with ms: YYYY-MM-DDTHH-MM-SS-mmm-rrrr
    const backup1Name = path.basename(backup1Path);
    expect(backup1Name).toMatch(/mcp\.json\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[a-f0-9]{4}$/);

    await writeAdjacentEmitReport(proposed2Path, mcpConfigPath, []);

    // Apply second immediately (same second, but different ms + random)
    const result2 = await applyConfig({
      mcpConfigPath,
      proposedPath: proposed2Path,
      dryRun: false,
      backup: true,
      yes: true,
    });

    expect(result2.success).toBe(true);
    expect(result2.backupPath).toBeDefined();
    const backup2Path = result2.backupPath!;
    expect(existsSync(backup2Path)).toBe(true);

    // Verify backups are DISTINCT (different names)
    expect(backup2Path).not.toBe(backup1Path);

    // Verify backup2 equals proposed1 (the state before second apply)
    // (normalize trailing newlines since applyConfig adds one)
    const backup2Content = await readFile(backup2Path, "utf8");
    const backup2JSON = JSON.parse(backup2Content);
    const proposed1JSON = JSON.parse(await readFile(proposed1Path, "utf8"));
    expect(backup2JSON).toEqual(proposed1JSON);
  });
});
