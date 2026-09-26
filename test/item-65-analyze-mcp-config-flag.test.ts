import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("node", [path.join(repoRoot, "dist", "cli.js"), ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("item 65: analyze accepts --mcp-config", () => {
  it("runs analyze with --mcp-config path", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item65-"));
    const configPath = path.join(testDir, "mcp.json");
    const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { stub: { command: "node", args: [stub] } } }, null, 2) + "\n",
      "utf8"
    );
    const { code, stdout } = await runCli(
      ["analyze", "--mcp-config", configPath, "--timeout", "5000"],
      testDir
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/stub/i);
    await rm(testDir, { recursive: true, force: true });
  });

  it("errors when positional and --mcp-config are both provided", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item65-b-"));
    const configPath = path.join(testDir, "mcp.json");
    await writeFile(configPath, '{"mcpServers":{}}\n', "utf8");
    const { code, stderr } = await runCli(
      ["analyze", configPath, "--mcp-config", configPath],
      testDir
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/not both/i);
    await rm(testDir, { recursive: true, force: true });
  });
});
