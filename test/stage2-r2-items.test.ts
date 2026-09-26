import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { discoverFromMcpConfig } from "../src/discover/fromMcpConfig.js";
import { analyzeTools } from "../src/pipeline.js";
import { formatTextReport } from "../src/report/formatText.js";
import { applyConfig } from "../src/apply/applyConfig.js";
import { buildClientProposedMcpConfig } from "../src/emit/writeArtifacts.js";
import { toolKey } from "../src/emit/keepHot.js";
import { writeAdjacentEmitReport } from "./apply-report-helper.js";
import {
  ALL_CLIENT_CONFIG_IDS,
  detectClientConfigs,
  getAppDataDirFor,
  getClientConfigById,
  getCodexHome,
} from "../src/discover/clientConfigs.js";
import {
  logicalConfigForProposal,
  mergeProposedOntoClientConfig,
  parseClientConfigContent,
} from "../src/config/configSurfaces.js";
import { computeConfigContentHash } from "../src/mcp/configGuards.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");

async function copyFixtureToTemp(
  relFixture: string,
  targetRelPath?: string
): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage2-r2-"));
  const rel = targetRelPath ?? path.basename(relFixture);
  const configPath = path.join(dir, rel);
  await mkdir(path.dirname(configPath), { recursive: true });
  await copyFile(path.join(repoRoot, relFixture), configPath);
  let content = await readFile(configPath, "utf8");
  content = content.replace(/fixtures\/stub-mcp-server\.mjs/g, stub);
  await writeFile(configPath, content, "utf8");
  return { dir, configPath };
}

function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

const WRITABLE_CLIENT_IDS = ALL_CLIENT_CONFIG_IDS.filter((id) => id !== "copilot-agent-host");

async function seedWritableClient(
  id: string,
  home: string,
  cwd: string
): Promise<{ configPath: string; proposedPath: string }> {
  const appData = getAppDataDirFor(process.platform, home, process.env);
  const stubArg = stub.replace(/\\/g, "/");
  let configPath = "";

  switch (id) {
    case "cursor-global":
      configPath = path.join(home, ".cursor", "mcp.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            alpha: { command: "node", args: [stubArg] },
          },
        }) + "\n",
        "utf8"
      );
      break;
    case "cursor-project":
      configPath = path.join(cwd, ".cursor", "mcp.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            alpha: { command: "node", args: [stubArg] },
          },
        }) + "\n",
        "utf8"
      );
      break;
    case "claude-desktop":
      configPath = path.join(appData, "Claude", "claude_desktop_config.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            alpha: { command: "node", args: [stubArg] },
          },
        }) + "\n",
        "utf8"
      );
      break;
    case "claude-code-global":
      configPath = path.join(home, ".claude.json");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            alpha: { command: "node", args: [stubArg] },
          },
        }) + "\n",
        "utf8"
      );
      break;
    case "claude-code-project":
      configPath = path.join(cwd, ".mcp.json");
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            alpha: { command: "node", args: [stubArg] },
          },
        }) + "\n",
        "utf8"
      );
      break;
    case "vscode-workspace":
      configPath = path.join(cwd, ".vscode", "mcp.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          servers: {
            alpha: {
              type: "stdio",
              command: "node",
              args: [stubArg],
            },
          },
        }) + "\n",
        "utf8"
      );
      break;
    case "vscode-user":
      configPath = path.join(appData, "Code", "User", "mcp.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          servers: {
            alpha: {
              type: "stdio",
              command: "node",
              args: [stubArg],
            },
          },
        }) + "\n",
        "utf8"
      );
      break;
    case "windsurf":
      configPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            alpha: { command: "node", args: [stubArg] },
          },
        }) + "\n",
        "utf8"
      );
      break;
    case "antigravity-global":
      configPath = path.join(home, ".gemini", "config", "mcp_config.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            alpha: { command: "node", args: [stubArg] },
          },
        }) + "\n",
        "utf8"
      );
      break;
    case "antigravity-workspace":
      configPath = path.join(cwd, ".agents", "mcp_config.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            alpha: { command: "node", args: [stubArg] },
          },
        }) + "\n",
        "utf8"
      );
      break;
    case "gemini-cli-user":
      configPath = path.join(home, ".gemini", "settings.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            alpha: { command: "node", args: [stubArg] },
          },
        }) + "\n",
        "utf8"
      );
      break;
    case "gemini-cli-project":
      configPath = path.join(cwd, ".gemini", "settings.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            alpha: { command: "node", args: [stubArg] },
          },
        }) + "\n",
        "utf8"
      );
      break;
    case "codex":
      configPath = path.join(getCodexHome(home, process.env), "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await copyFile(
        path.join(repoRoot, "fixtures/clients/codex/config.toml"),
        configPath
      );
      {
        let codexContent = await readFile(configPath, "utf8");
        codexContent = codexContent.replace(/fixtures\/stub-mcp-server\.mjs/g, stubArg);
        await writeFile(configPath, codexContent, "utf8");
      }
      break;
    case "codex-project":
      configPath = path.join(cwd, ".codex", "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await copyFile(
        path.join(repoRoot, "fixtures/clients/codex/config.toml"),
        configPath
      );
      {
        let codexContent = await readFile(configPath, "utf8");
        codexContent = codexContent.replace(/fixtures\/stub-mcp-server\.mjs/g, stubArg);
        await writeFile(configPath, codexContent, "utf8");
      }
      break;
    default:
      throw new Error(`unhandled client id ${id}`);
  }

  const content = await readFile(configPath, "utf8");
  const parsed = parseClientConfigContent(content, configPath);
  const logical = logicalConfigForProposal(parsed, configPath);
  const proposedFull = mergeProposedOntoClientConfig(parsed, configPath, logical);
  const proposedPath = path.join(path.dirname(configPath), "proposed.json");
  await writeFile(proposedPath, JSON.stringify(proposedFull, null, 2) + "\n", "utf8");
  await writeAdjacentEmitReport(proposedPath, configPath, []);
  return { configPath, proposedPath };
}

describe("Stage 2 round 2 fixes", () => {
  it("stage2-r2-item1-jsonc-analyze-emit-apply-cli", async () => {
    const { dir, configPath } = await copyFixtureToTemp(
      "fixtures/clients/vscode/user-settings.jsonc",
      "Code/User/settings.json"
    );
    try {
      const analyze = runCli(["analyze", configPath, "--timeout", "20000"], dir);
      expect(analyze.status).toBe(0);
      expect(analyze.stderr).not.toContain("JSON syntax error");

      const parsed = parseClientConfigContent(await readFile(configPath, "utf8"), configPath);
      const { tools, servers } = await discoverFromMcpConfig(configPath, {
        timeoutMs: 20_000,
      });
      const report = analyzeTools(tools, servers);
      const hot = new Set(report.tools.map((m) => toolKey(m.server, m.name)));
      const { proposed } = buildClientProposedMcpConfig(
        configPath,
        parsed,
        hot,
        new Set(),
        report.tools,
        { report }
      );
      const proposedPath = path.join(dir, "proposed.json");
      await writeFile(proposedPath, JSON.stringify(proposed, null, 2) + "\n", "utf8");
      await writeAdjacentEmitReport(proposedPath, configPath, []);

      const apply = runCli(
        [
          "apply",
          "--mcp-config",
          configPath,
          "--proposed",
          proposedPath,
          "--backup",
          "--yes",
        ],
        dir
      );
      expect(apply.status).toBe(0);
      const after = await readFile(configPath, "utf8");
      expect(after).toContain("// VS Code user MCP (JSONC)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stage2-r2-item2-apply-client-without-implicit-mcp-config", async () => {
    const home = os.homedir();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "stage2-r2-cwd-"));
    try {
      for (const id of WRITABLE_CLIENT_IDS) {
        const { proposedPath } = await seedWritableClient(id, home, cwd);
        expect(await getClientConfigById(id, cwd)).toBeTruthy();
        const res = runCli(
          [
            "apply",
            "--client",
            id,
            "--proposed",
            proposedPath,
            "--backup",
            "--yes",
          ],
          cwd
        );
        expect(res.status, `${id}: ${res.stderr}`).toBe(0);
        expect(res.stderr).not.toContain("not both");
      }

      const windsurf = await getClientConfigById("windsurf", cwd);
      expect(windsurf).toBeTruthy();
      const conflict = runCli(
        [
          "apply",
          "--client",
          "windsurf",
          "--mcp-config",
          windsurf!.path,
          "--proposed",
          path.join(path.dirname(windsurf!.path), "proposed.json"),
          "--backup",
          "--yes",
        ],
        cwd
      );
      expect(conflict.status).toBe(2);
      expect(conflict.stderr).toContain("not both");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stage2-r2-item3-vscode-client-alias-and-unknown-ids", async () => {
    const home = os.homedir();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "stage2-r2-alias-cwd-"));
    try {
      await seedWritableClient("vscode-user", home, cwd);
      const ok = runCli(["emit", "--client", "vscode", "--tools-json", path.join(repoRoot, "fixtures/tools-live-shaped.json"), "--out", cwd], cwd);
      expect(ok.status).toBe(0);

      const bad = runCli(["emit", "--client", "not-a-real-client", "--out", cwd], cwd);
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain("Unknown --client id");
      expect(bad.stderr).toContain("vscode-user");
      expect(bad.stderr).toContain("Valid client ids:");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stage2-r2-item4-disabled-server-zero-tokens-in-total", async () => {
    const { dir, configPath } = await copyFixtureToTemp(
      "fixtures/clients/windsurf/mcp_config-disabled-server.json"
    );
    try {
      const { tools, servers } = await discoverFromMcpConfig(configPath, {
        timeoutMs: 20_000,
      });
      const report = analyzeTools(tools, servers);
      const text = formatTextReport(report);
      expect(text).toContain("Disabled servers (config, 0 active tokens):");
      expect(text).toContain("disabled-one");
      expect(servers.some((s) => s.name === "disabled-one" && s.status === "config_disabled")).toBe(
        true
      );
      expect(report.tools.every((t) => t.server !== "disabled-one")).toBe(true);
      const enabledReport = analyzeTools(
        tools.filter((t) => t.server === "enabled"),
        servers.filter((s) => s.name === "enabled")
      );
      expect(report.totals.estTokens).toBe(enabledReport.totals.estTokens);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stage2-r2-item5-apply-preserves-key-order-and-style", async () => {
    const { dir, configPath } = await copyFixtureToTemp(
      "fixtures/clients/vscode/workspace-mcp-compact.json",
      "mcp.json"
    );
    try {
      const original = await readFile(configPath, "utf8");
      expect(original).toMatch(
        /"alpha": \{ "type": "stdio", "command": "node"/
      );
      expect(original).toContain('"beta": { "type": "stdio"');
      expect(original).toMatch(/"beta": \{[^}]+\},\s*\n/);

      const parsed = parseClientConfigContent(original, configPath);
      const { tools, servers } = await discoverFromMcpConfig(configPath, {
        timeoutMs: 20_000,
      });
      const report = analyzeTools(tools, servers);
      const hot = new Set(report.tools.map((m) => toolKey(m.server, m.name)));
      const { proposed } = buildClientProposedMcpConfig(
        configPath,
        parsed,
        hot,
        new Set(),
        report.tools,
        { report }
      );
      const proposedPath = path.join(dir, "proposed.json");
      await writeFile(proposedPath, JSON.stringify(proposed, null, 2) + "\n", "utf8");
      await writeAdjacentEmitReport(proposedPath, configPath, []);

      const result = await applyConfig({
        mcpConfigPath: configPath,
        proposedPath,
        dryRun: false,
        backup: true,
        yes: true,
      });
      expect(result.success).toBe(true);
      const after = await readFile(configPath, "utf8");
      expect(after).toMatch(/"alpha": \{ "type": "stdio", "command": "node"/);
      expect(after).toContain('"beta": { "type": "stdio"');
      expect(after).toMatch(/"beta": \{[^}]+\},\s*\n/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stage2-r2-item6-windsurf-devin-detected-by-config-path", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "stage2-r2-windsurf-"));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "stage2-r2-windsurf-cwd-"));
    const windsurfPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");
    await mkdir(path.dirname(windsurfPath), { recursive: true });
    await writeFile(windsurfPath, '{"mcpServers":{}}\n', "utf8");
    const configs = await detectClientConfigs(cwd, {
      homedir: () => home,
      platform: () => process.platform,
      env: { USERPROFILE: home },
    });
    const windsurf = configs.find((c) => c.id === "windsurf");
    expect(windsurf?.path).toBe(windsurfPath);
    expect(windsurf?.name).toBe("Windsurf (Devin)");
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it("stage2-r2-item7-codex-round-trip-preserves-comments-and-non-mcp", async () => {
    const { dir, configPath } = await copyFixtureToTemp(
      "fixtures/clients/codex/config.toml",
      ".codex/config.toml"
    );
    try {
      const parsed = parseClientConfigContent(await readFile(configPath, "utf8"), configPath);
      const { tools, servers } = await discoverFromMcpConfig(configPath, {
        timeoutMs: 20_000,
      });
      const report = analyzeTools(tools, servers);
      const hot = new Set(report.tools.map((m) => toolKey(m.server, m.name)));
      const { proposed } = buildClientProposedMcpConfig(
        configPath,
        parsed,
        hot,
        new Set(["beta"]),
        report.tools,
        { report }
      );
      const proposedPath = path.join(dir, "proposed.json");
      await writeFile(proposedPath, JSON.stringify(proposed, null, 2) + "\n", "utf8");
      await writeAdjacentEmitReport(proposedPath, configPath, ["beta"]);

      const result = await applyConfig({
        mcpConfigPath: configPath,
        proposedPath,
        dryRun: false,
        backup: true,
        yes: true,
      });
      expect(result.success).toBe(true);
      const after = await readFile(configPath, "utf8");
      expect(after).toContain("# OpenAI Codex user configuration");
      expect(after).toContain('model = "o3"');
      expect(after).toContain("[features]");
      expect(after).toContain("network_proxy.enabled");
      expect(after).toContain("[mcp_servers.alpha]");
      expect(after).not.toMatch(/\[mcp_servers\.beta\]/);
      expect(after).toContain("[mcp_servers.off]");
      expect(after).toContain("enabled = false");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stage2-r2-item7-codex-path-win32-userprofile", async () => {
    const home = path.join(os.tmpdir(), "fake-win-codex");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-win-cwd-"));
    const codexPath = path.join(home, ".codex", "config.toml");
    await mkdir(path.dirname(codexPath), { recursive: true });
    await writeFile(codexPath, "[mcp_servers]\n", "utf8");
    const configs = await detectClientConfigs(cwd, {
      homedir: () => home,
      platform: () => "win32",
      env: { USERPROFILE: home },
    });
    expect(configs.some((c) => c.id === "codex" && c.path === codexPath)).toBe(true);
    await rm(cwd, { recursive: true, force: true });
  });

  it("stage2-r2-item7-codex-path-darwin-and-linux", async () => {
    const homeDarwin = path.join(os.tmpdir(), "fake-darwin-codex");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-unix-cwd-"));
    const darwinPath = path.join(homeDarwin, ".codex", "config.toml");
    await mkdir(path.dirname(darwinPath), { recursive: true });
    await writeFile(darwinPath, "[mcp_servers]\n", "utf8");
    const darwinConfigs = await detectClientConfigs(cwd, {
      homedir: () => homeDarwin,
      platform: () => "darwin",
      env: {},
    });
    expect(darwinConfigs.some((c) => c.id === "codex" && c.path === darwinPath)).toBe(true);

    const homeLinux = path.join(os.tmpdir(), "fake-linux-codex");
    const linuxPath = path.join(homeLinux, ".codex", "config.toml");
    await mkdir(path.dirname(linuxPath), { recursive: true });
    await writeFile(linuxPath, "[mcp_servers]\n", "utf8");
    const linuxConfigs = await detectClientConfigs(cwd, {
      homedir: () => homeLinux,
      platform: () => "linux",
      env: {},
    });
    expect(linuxConfigs.some((c) => c.id === "codex" && c.path === linuxPath)).toBe(true);
    await rm(cwd, { recursive: true, force: true });
  });

  it("stage2-r2-item7-codex-codex-home-override", async () => {
    const home = path.join(os.tmpdir(), "fake-codex-home-parent");
    const codexHome = path.join(os.tmpdir(), "custom-codex-home-override");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-override-cwd-"));
    const codexPath = path.join(codexHome, "config.toml");
    await mkdir(codexHome, { recursive: true });
    await writeFile(codexPath, "[mcp_servers]\n", "utf8");
    const configs = await detectClientConfigs(cwd, {
      homedir: () => home,
      platform: () => "linux",
      env: { CODEX_HOME: codexHome },
    });
    expect(configs.some((c) => c.id === "codex" && c.path === codexPath)).toBe(true);
    await rm(cwd, { recursive: true, force: true });
  });

  it("stage2-r2-item7-codex-disabled-excluded-from-totals", async () => {
    const { dir, configPath } = await copyFixtureToTemp(
      "fixtures/clients/codex/config.toml",
      ".codex/config.toml"
    );
    try {
      const { tools, servers } = await discoverFromMcpConfig(configPath, {
        timeoutMs: 20_000,
      });
      const report = analyzeTools(tools, servers);
      expect(servers.some((s) => s.name === "off" && s.status === "config_disabled")).toBe(
        true
      );
      expect(report.tools.every((t) => t.server !== "off")).toBe(true);
      const enabledOnly = analyzeTools(
        tools.filter((t) => t.server !== "off"),
        servers.filter((s) => s.name !== "off")
      );
      expect(report.totals.estTokens).toBe(enabledOnly.totals.estTokens);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stage2-r2-item7-codex-cli-apply-client-codex", async () => {
    const home = os.homedir();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "stage2-r2-codex-apply-"));
    try {
      const { proposedPath } = await seedWritableClient("codex", home, cwd);
      expect(await getClientConfigById("codex", cwd)).toBeTruthy();
      const res = runCli(
        ["apply", "--client", "codex", "--proposed", proposedPath, "--backup", "--yes"],
        cwd
      );
      expect(res.status, res.stderr).toBe(0);
      expect(res.stderr).not.toContain("not both");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
