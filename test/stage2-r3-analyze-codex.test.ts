import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { ALL_CLIENT_CONFIG_IDS, getCodexHome } from "../src/discover/clientConfigs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");

function runCli(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: env ?? process.env,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

async function writeCodexTomlWithDisabled(
  configPath: string
): Promise<void> {
  const stubArg = stub.replace(/\\/g, "/");
  const content = `# Codex MCP config (comments preserved)
model = "o3"

[mcp_servers.enabled_one]
command = "node"
args = ["${stubArg}"]

[mcp_servers.disabled_one]
command = "node"
args = ["${stubArg}"]
enabled = false
`;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, content, "utf8");
}

describe("stage2-r3 analyze codex", () => {
  it("stage2-r3-analyze-toml-path-comments-and-disabled-excluded", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stage2-r3-toml-"));
    const configPath = path.join(dir, "config.toml");
    try {
      await writeCodexTomlWithDisabled(configPath);
      const analyze = runCli(["analyze", configPath, "--timeout", "20000"], dir);
      expect(analyze.status).toBe(0);
      expect(analyze.stderr).not.toContain("JSON syntax error");
      expect(analyze.stdout).toContain("Disabled servers (config, 0 active tokens):");
      expect(analyze.stdout).toContain("disabled_one");
      const totalsMatch = analyze.stdout.match(
        /totals: ~\d+ tokens \(estimate\) across (\d+) tools \/ (\d+) servers/
      );
      expect(totalsMatch).not.toBeNull();
      expect(Number(totalsMatch![2])).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stage2-r3-analyze-client-codex-resolves-toml", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "stage2-r3-home-"));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "stage2-r3-cwd-"));
    const configPath = path.join(getCodexHome(home, process.env), "config.toml");
    try {
      await writeCodexTomlWithDisabled(configPath);
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      const analyze = runCli(
        ["analyze", "--client", "codex", "--timeout", "20000"],
        cwd,
        env
      );
      expect(analyze.status).toBe(0);
      expect(analyze.stderr).not.toContain("unknown option '--client'");
      expect(analyze.stdout).toContain("disabled_one");
      const totalsMatch = analyze.stdout.match(
        /totals: ~\d+ tokens \(estimate\) across (\d+) tools \/ (\d+) servers/
      );
      expect(totalsMatch).not.toBeNull();
      expect(Number(totalsMatch![2])).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stage2-r3-analyze-client-unknown-id-and-help", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "stage2-r3-help-"));
    try {
      const help = runCli(["analyze", "--help"], cwd);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("--client");

      const bad = runCli(["analyze", "--client", "not-a-real-client"], cwd);
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain("Unknown --client id");
      expect(bad.stderr).toContain("Valid client ids:");
      expect(bad.stderr).toContain(ALL_CLIENT_CONFIG_IDS[0]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stage2-r3-analyze-client-and-path-mutually-exclusive", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stage2-r3-both-"));
    const configPath = path.join(dir, "config.toml");
    try {
      await writeCodexTomlWithDisabled(configPath);
      const res = runCli(
        ["analyze", configPath, "--client", "codex", "--timeout", "20000"],
        dir
      );
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("Use either --client <id> or a config path, not both.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
