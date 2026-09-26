import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { EXIT_CONFIG_BUDGET } from "../src/analyze/postAnalyze.js";
import { parseHistoryFile } from "../src/history/store.js";
import { loadUserConfig } from "../src/state/userConfig.js";
import { getAnalyzeHistoryFilePath, getUserConfigFilePath } from "../src/state/userStatePaths.js";
import { parseClientConfigContent } from "../src/config/configSurfaces.js";

function withUtf8Bom(text: string): string {
  return `\uFEFF${text}`;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const toolsTiny = path.join(repoRoot, "fixtures", "tools-tiny.json");
const toolsSecrets = path.join(repoRoot, "fixtures", "mcp-with-secrets.json");

function runCli(args: string[], env?: Record<string, string>) {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe("stage3d history and budgets", () => {
  let stateDir: string;
  let historyFile: string;
  let configFile: string;
  let envBase: Record<string, string>;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "stage3d-state-"));
    historyFile = path.join(stateDir, "analyze-history.json");
    configFile = path.join(stateDir, "config.json");
    envBase = {
      TOOL_TOKEN_BUDGET_STATE_DIR: stateDir,
      TOOL_TOKEN_BUDGET_HISTORY_FILE: historyFile,
      TOOL_TOKEN_BUDGET_USER_CONFIG: configFile,
    };
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("stage3d-history-appended-on-analyze", async () => {
    const a = runCli(["analyze", "--tools-json", toolsTiny], envBase);
    expect(a.status).toBe(0);
    const raw = await readFile(historyFile, "utf8");
    const parsed = parseHistoryFile(raw);
    expect(parsed?.entries.length).toBe(1);
    expect(parsed?.entries[0]?.totalTokens).toBeGreaterThan(0);
  });

  it("stage3d-history-opt-out-flag", async () => {
    runCli(["analyze", "--tools-json", toolsTiny, "--no-history"], envBase);
    await expect(readFile(historyFile, "utf8")).rejects.toThrow();
  });

  it("stage3d-history-opt-out-env", async () => {
    runCli(["analyze", "--tools-json", toolsTiny], {
      ...envBase,
      TOOL_TOKEN_BUDGET_NO_HISTORY: "1",
    });
    await expect(readFile(historyFile, "utf8")).rejects.toThrow();
  });

  it("stage3d-history-corrupt-file-does-not-break-analyze", async () => {
    await writeFile(historyFile, "{not json", "utf8");
    const res = runCli(["analyze", "--tools-json", toolsTiny], envBase);
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/warn: analyze history/i);
    const parsed = parseHistoryFile(await readFile(historyFile, "utf8"));
    expect(parsed?.entries.length).toBe(1);
  });

  it("stage3d-history-cap-rotation", async () => {
    await writeFile(
      configFile,
      JSON.stringify({ history: { maxEntries: 3 } }) + "\n",
      "utf8"
    );
    for (let i = 0; i < 5; i++) {
      runCli(["analyze", "--tools-json", toolsTiny], envBase);
    }
    const parsed = parseHistoryFile(await readFile(historyFile, "utf8"));
    expect(parsed?.entries.length).toBe(3);
  });

  it("stage3d-history-no-secrets", async () => {
    runCli(["analyze", toolsSecrets], envBase);
    const raw = await readFile(historyFile, "utf8");
    expect(raw).not.toMatch(/SECRET_TOKEN|fake-api-key|should-never-appear/i);
  });

  it("stage3d-history-command-sparkline", async () => {
    runCli(["analyze", "--tools-json", toolsTiny], envBase);
    runCli(["analyze", "--tools-json", toolsTiny], envBase);
    const res = runCli(["history"], envBase);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/▁|▂|▃|▄|▅|▆|▇|█/);
    expect(res.stdout).toMatch(/totals/i);
  });

  it("stage3d-history-command-json", async () => {
    runCli(["analyze", "--tools-json", toolsTiny], envBase);
    const res = runCli(["history", "--json"], envBase);
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout) as { entries: unknown[]; sparklines: { totals: string } };
    expect(payload.entries.length).toBe(1);
    expect(payload.sparklines.totals.length).toBeGreaterThan(0);
  });

  it("stage3d-history-empty", () => {
    const res = runCli(["history"], envBase);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/No analyze history yet/i);
  });

  async function seedCursorGlobalConfig(): Promise<void> {
    const home = process.env.HOME!;
    const mcpPath = path.join(home, ".cursor", "mcp.json");
    await mkdir(path.dirname(mcpPath), { recursive: true });
    await writeFile(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2) + "\n", "utf8");
  }

  it("stage3d-budget-warning-per-client", async () => {
    await seedCursorGlobalConfig();
    await writeFile(
      configFile,
      JSON.stringify({ budget: { clients: { "cursor-global": 1 } } }) + "\n",
      "utf8"
    );
    const res = runCli(
      ["analyze", "--tools-json", toolsTiny, "--client", "cursor-global"],
      envBase
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/budget exceeded for client cursor-global/i);
  });

  it("stage3d-budget-warning-per-model", async () => {
    await writeFile(
      configFile,
      JSON.stringify({ budget: { models: { "openai:o200k": 1 } } }) + "\n",
      "utf8"
    );
    const res = runCli(
      ["analyze", "--tools-json", toolsTiny, "--model", "openai:o200k"],
      envBase
    );
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/budget exceeded for model openai:o200k/i);
  });

  it("stage3d-fail-over-budget-exit-code", async () => {
    await writeFile(
      configFile,
      JSON.stringify({ budget: { total: 1 } }) + "\n",
      "utf8"
    );
    const res = runCli(
      ["analyze", "--tools-json", toolsTiny, "--fail-over-budget"],
      envBase
    );
    expect(res.status).toBe(EXIT_CONFIG_BUDGET);
  });

  it("stage3d-no-fail-without-flag", async () => {
    await writeFile(
      configFile,
      JSON.stringify({ budget: { total: 1 } }) + "\n",
      "utf8"
    );
    const res = runCli(["analyze", "--tools-json", toolsTiny], envBase);
    expect(res.status).toBe(0);
  });

  it("stage3d-budget-json-status", async () => {
    await writeFile(
      configFile,
      JSON.stringify({ budget: { total: 1 } }) + "\n",
      "utf8"
    );
    const res = runCli(["analyze", "--tools-json", toolsTiny, "--json"], envBase);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout) as {
      budgetStatus?: { anyExceeded: boolean; checks: unknown[] };
    };
    expect(report.budgetStatus?.anyExceeded).toBe(true);
    expect(report.budgetStatus?.checks.length).toBeGreaterThan(0);
  });

  it("stage3d-budget-invalid-config-error", async () => {
    await writeFile(configFile, JSON.stringify({ budget: { total: "nope" } }) + "\n", "utf8");
    const res = runCli(["analyze", "--tools-json", toolsTiny], envBase);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/Invalid budget config/i);
  });

  it("stage3d-state-path-windows-appdata", () => {
    const home = path.join(tmpdir(), "stage3d-win-home");
    const appData = path.join(home, "AppData", "Roaming");
    const resolved = getAnalyzeHistoryFilePath({
      homedir: () => home,
      platform: () => "win32",
      env: { APPDATA: appData },
    });
    expect(resolved).toBe(path.join(appData, "tool-token-budget", "analyze-history.json"));
  });

  it("stage3d-user-config-default-path", () => {
    const p = getUserConfigFilePath();
    expect(p).toContain("tool-token-budget");
    expect(p.endsWith("config.json")).toBe(true);
  });

  it("stage3d-bom-config-json-loads", async () => {
    await writeFile(
      configFile,
      withUtf8Bom(JSON.stringify({ budget: { total: 99_999 } }) + "\n"),
      "utf8"
    );
    const loaded = await loadUserConfig({
      env: { TOOL_TOKEN_BUDGET_USER_CONFIG: configFile },
    });
    expect(loaded.config.budget?.total).toBe(99_999);
  });

  it("stage3d-bom-fail-over-budget-exit-3", async () => {
    await writeFile(
      configFile,
      withUtf8Bom(JSON.stringify({ budget: { total: 1 } }) + "\n"),
      "utf8"
    );
    const res = runCli(
      ["analyze", "--tools-json", toolsTiny, "--fail-over-budget"],
      envBase
    );
    expect(res.status).toBe(EXIT_CONFIG_BUDGET);
    expect(res.status).toBe(3);
  });

  it("stage3d-bom-history-file-loads", async () => {
    const entry = {
      at: "2026-09-20T10:00:00.000Z",
      totalTokens: 12,
      byClient: {},
      byModel: { "openai:o200k": 12 },
    };
    await writeFile(
      historyFile,
      withUtf8Bom(JSON.stringify({ version: 1, entries: [entry] }, null, 2) + "\n"),
      "utf8"
    );
    const parsed = parseHistoryFile(await readFile(historyFile, "utf8"));
    expect(parsed?.entries.length).toBe(1);
    const res = runCli(["history", "--json"], envBase);
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout) as { entries: unknown[] };
    expect(payload.entries.length).toBe(1);
  });

  it("stage3d-bom-client-config-parsed", () => {
    const raw = withUtf8Bom(
      JSON.stringify({ mcpServers: { demo: { command: "node", args: ["x.js"] } } }) + "\n"
    );
    const parsed = parseClientConfigContent(raw, "mcp.json") as {
      mcpServers?: Record<string, unknown>;
    };
    expect(parsed.mcpServers?.demo).toBeDefined();
  });
});
