import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  ALL_CLIENT_CONFIG_IDS,
  detectClientConfigs,
  getAppDataDirFor,
  getCodexHome,
} from "../src/discover/clientConfigs.js";
import {
  parseClientConfigContent,
  getServerNamesFromClientConfig,
} from "../src/config/configSurfaces.js";
import {
  syncMcpClients,
  SyncValidationError,
  SYNC_ERROR_CODES,
  expectedClientConfigPath,
} from "../src/mcp/syncMcpClients.js";
import {
  canonicalizeServerEntry,
  translateCanonicalToTargetLogical,
  capabilitiesForSurfaceKind,
} from "../src/mcp/syncClientCapabilities.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");

function runCli(args: string[], cwd: string, env?: Record<string, string>) {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
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

async function seedClientConfig(
  id: string,
  home: string,
  cwd: string,
  mcpServers: Record<string, unknown>
): Promise<string> {
  const appData = getAppDataDirFor(process.platform, home, process.env);
  const stubArg = stub.replace(/\\/g, "/");
  const normalized = JSON.parse(JSON.stringify(mcpServers).replace(/STUB/g, stubArg)) as Record<
    string,
    unknown
  >;

  let configPath = "";
  switch (id) {
    case "cursor-global":
      configPath = path.join(home, ".cursor", "mcp.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ mcpServers: normalized }, null, 2) + "\n",
        "utf8"
      );
      break;
    case "windsurf":
      configPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ mcpServers: normalized }, null, 2) + "\n",
        "utf8"
      );
      break;
    case "vscode-user":
      configPath = path.join(appData, "Code", "User", "settings.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await copyFile(
        path.join(repoRoot, "fixtures/clients/vscode/user-settings.jsonc"),
        configPath
      );
      {
        const parsed = parseClientConfigContent(
          await readFile(configPath, "utf8"),
          configPath
        ) as Record<string, unknown>;
        const mcp = parsed.mcp as Record<string, unknown>;
        mcp.servers = {
          legacy: {
            type: "stdio",
            command: "node",
            args: [stubArg],
          },
        };
        await writeFile(configPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
      }
      break;
    case "codex":
      configPath = path.join(getCodexHome(home, process.env), "config.toml");
      await mkdir(path.dirname(configPath), { recursive: true });
      await copyFile(path.join(repoRoot, "fixtures/clients/codex/config.toml"), configPath);
      break;
    default:
      throw new Error(`seedClientConfig: unsupported id ${id}`);
  }
  return configPath;
}

describe("Stage 3c — cross-client MCP sync", () => {
  let home: string;
  let cwd: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "stage3c-home-"));
    cwd = await mkdtemp(path.join(os.tmpdir(), "stage3c-cwd-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.APPDATA = path.join(home, "AppData", "Roaming");
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    await mkdir(process.env.APPDATA, { recursive: true });
    await mkdir(process.env.XDG_CONFIG_HOME, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true }).catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  });

  it("stage3c-sync-dry-run-writes-nothing", async () => {
    await seedClientConfig(
      "cursor-global",
      home,
      cwd,
      {
        alpha: { command: "node", args: ["STUB"] },
        beta: { command: "node", args: ["STUB"] },
      }
    );
    await seedClientConfig("windsurf", home, cwd, {
      alpha: { command: "node", args: ["STUB"] },
      extra: { command: "node", args: ["STUB"] },
    });
    const windsurfPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");
    const before = await readFile(windsurfPath, "utf8");

    const result = await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "windsurf",
      dryRun: true,
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    expect(result.dryRun).toBe(true);
    expect(result.applied).toBe(false);
    expect(result.targets[0]?.removed).toContain("extra");
    expect(await readFile(windsurfPath, "utf8")).toBe(before);
    const backups = (await readdir(path.dirname(windsurfPath))).filter((f) =>
      f.includes(".bak-")
    );
    expect(backups).toHaveLength(0);
  });

  it("stage3c-sync-removes-extra-servers", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      only: { command: "node", args: ["STUB"] },
    });
    await seedClientConfig("windsurf", home, cwd, {
      only: { command: "node", args: ["STUB"] },
      stray: { command: "node", args: ["STUB"] },
    });
    const windsurfPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");

    await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "windsurf",
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    const parsed = parseClientConfigContent(
      await readFile(windsurfPath, "utf8"),
      windsurfPath
    );
    const names = getServerNamesFromClientConfig(parsed, windsurfPath);
    expect(names.has("stray")).toBe(false);
    expect(names.has("only")).toBe(true);
  });

  it("stage3c-sync-backup-created", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      s: { command: "node", args: ["STUB"] },
    });
    await seedClientConfig("windsurf", home, cwd, {
      s: { command: "node", args: ["STUB"] },
      drop: { command: "node", args: ["STUB"] },
    });
    const windsurfPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");
    const before = await readFile(windsurfPath, "utf8");

    const result = await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "windsurf",
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    expect(result.applied).toBe(true);
    expect(result.targets[0]?.backupPath).toBeTruthy();
    const backup = await readFile(result.targets[0]!.backupPath!, "utf8");
    expect(backup).toBe(before);
  });

  it("stage3c-sync-confirm-required-without-yes", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      a: { command: "node", args: ["STUB"] },
    });
    await seedClientConfig("windsurf", home, cwd, {
      a: { command: "node", args: ["STUB"] },
      b: { command: "node", args: ["STUB"] },
    });
    const windsurfPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");
    const before = await readFile(windsurfPath, "utf8");

    await expect(
      syncMcpClients({
        fromClientId: "cursor-global",
        toClientId: "windsurf",
        confirm: async () => false,
        cwd,
        detectDeps: { homedir: () => home, platform: () => process.platform },
      })
    ).rejects.toMatchObject({ code: SYNC_ERROR_CODES.CANCELLED });

    expect(await readFile(windsurfPath, "utf8")).toBe(before);
  });

  it("stage3c-sync-env-headers-preserved", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      remote: {
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer secret-token" },
      },
    });
    await seedClientConfig("windsurf", home, cwd, {
      other: { command: "node", args: ["STUB"] },
    });
    const windsurfPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");

    await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "windsurf",
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    const text = await readFile(windsurfPath, "utf8");
    expect(text).toContain("Authorization");
    expect(text).toContain("Bearer secret-token");
    expect(text).not.toContain("other");
  });

  it("stage3c-sync-disabled-flag-mapping", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      on: { command: "node", args: ["STUB"] },
      off: { command: "node", args: ["STUB"], disabled: true },
    });
    await seedClientConfig("windsurf", home, cwd, {
      on: { command: "node", args: ["STUB"] },
    });
    const windsurfPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");

    await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "windsurf",
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    const parsed = parseClientConfigContent(
      await readFile(windsurfPath, "utf8"),
      windsurfPath
    );
    const servers = (parsed as { mcpServers: Record<string, { disabled?: boolean }> }).mcpServers;
    expect(servers.off.disabled).toBe(true);
  });

  it("stage3c-sync-warns-unsupported-field-and-skips", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      withHeaders: {
        url: "https://example.com/mcp",
        headers: { "X-Custom": "1" },
      },
    });
    const codexPath = await seedClientConfig("codex", home, cwd, {});

    const result = await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "codex",
      dryRun: true,
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    expect(result.warnings.some((w) => w.includes("headers"))).toBe(true);
    expect(result.targets[0]?.skippedServers.some((s) => s.name === "withHeaders")).toBe(
      true
    );
    const parsed = parseClientConfigContent(await readFile(codexPath, "utf8"), codexPath);
    expect(getServerNamesFromClientConfig(parsed, codexPath).has("withHeaders")).toBe(false);
  });

  it("stage3c-sync-jsonc-preserves-comments", async () => {
    const appData = getAppDataDirFor(process.platform, home, process.env);
    const settingsPath = path.join(appData, "Code", "User", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const golden = await readFile(
      path.join(repoRoot, "fixtures/clients/vscode/user-settings.jsonc"),
      "utf8"
    );
    await writeFile(settingsPath, golden, "utf8");

    await seedClientConfig("cursor-global", home, cwd, {
      synced: { command: "node", args: [stub.replace(/\\/g, "/")] },
    });

    await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "vscode-user",
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    const after = await readFile(settingsPath, "utf8");
    expect(after).toContain("// VS Code user MCP (JSONC)");
    expect(after).toContain("synced");
  });

  it("stage3c-sync-codex-toml-roundtrip", async () => {
    const codexPath = await seedClientConfig("codex", home, cwd, {});
    let codexContent = await readFile(codexPath, "utf8");
    codexContent = codexContent.replace(/fixtures\/stub-mcp-server\.mjs/g, stub.replace(/\\/g, "/"));
    await writeFile(codexPath, codexContent, "utf8");

    await seedClientConfig("windsurf", home, cwd, {
      local: { command: "node", args: ["STUB"] },
    });

    await syncMcpClients({
      fromClientId: "codex",
      toClientId: "windsurf",
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    const windsurfPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");
    const parsed = parseClientConfigContent(
      await readFile(windsurfPath, "utf8"),
      windsurfPath
    );
    const names = getServerNamesFromClientConfig(parsed, windsurfPath);
    expect(names.has("alpha")).toBe(true);
    expect(names.has("beta")).toBe(true);
    expect(names.has("local")).toBe(false);
  });

  it("stage3c-sync-to-all-skips-source", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      a: { command: "node", args: ["STUB"] },
    });
    await seedClientConfig("windsurf", home, cwd, {
      a: { command: "node", args: ["STUB"] },
    });

    const result = await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "all",
      dryRun: true,
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    expect(result.targets.every((t) => t.clientId !== "cursor-global")).toBe(true);
    expect(result.skippedClients.some((s) => s.clientId === "cursor-global")).toBe(false);
    expect(result.skippedClients.length).toBeGreaterThan(0);
    expect(result.targets.some((t) => t.clientId === "windsurf")).toBe(true);
  });

  it("stage3c-sync-json-output", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      a: { command: "node", args: ["STUB"] },
    });
    await seedClientConfig("windsurf", home, cwd, {
      a: { command: "node", args: ["STUB"] },
    });

    const result = await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "windsurf",
      dryRun: true,
      json: true,
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    expect(result.sourceClientId).toBe("cursor-global");
    expect(result.targets[0]?.noOp).toBe(true);
  });

  it("stage3c-sync-error-unknown-client", async () => {
    await expect(
      syncMcpClients({
        fromClientId: "not-a-client",
        toClientId: "windsurf",
        cwd,
        detectDeps: { homedir: () => home, platform: () => process.platform },
      })
    ).rejects.toBeInstanceOf(SyncValidationError);
  });

  it("stage3c-sync-error-source-equals-target", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      a: { command: "node", args: ["STUB"] },
    });
    await expect(
      syncMcpClients({
        fromClientId: "cursor-global",
        toClientId: "cursor-global",
        cwd,
        detectDeps: { homedir: () => home, platform: () => process.platform },
      })
    ).rejects.toThrow("--from and --to must name different");
  });

  it("stage3c-sync-error-missing-source-config", async () => {
    await expect(
      syncMcpClients({
        fromClientId: "cursor-global",
        toClientId: "windsurf",
        cwd,
        detectDeps: { homedir: () => home, platform: () => process.platform },
      })
    ).rejects.toThrow(/Source client.*not found/);
  });

  it("stage3c-sync-vscode-skips-disabled-server-with-warning", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      off: { command: "node", args: ["STUB"], disabled: true },
    });
    const appData = getAppDataDirFor(process.platform, home, process.env);
    const settingsPath = path.join(appData, "Code", "User", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ mcp: { servers: {} } }, null, 2) + "\n",
      "utf8"
    );

    const result = await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "vscode-user",
      dryRun: true,
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    expect(result.warnings.some((w) => w.includes("disabled flag"))).toBe(true);
  });

  it("stage3c-sync-cli-dry-run-exits-zero", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      a: { command: "node", args: ["STUB"] },
    });
    await seedClientConfig("windsurf", home, cwd, {
      a: { command: "node", args: ["STUB"] },
      b: { command: "node", args: ["STUB"] },
    });

    const res = runCli(
      ["sync", "--from", "cursor-global", "--to", "windsurf", "--dry-run", "--yes"],
      cwd,
      {
        HOME: home,
        USERPROFILE: home,
        APPDATA: process.env.APPDATA!,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME!,
      }
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout + res.stderr).toContain("Dry-run");
  });

  it("stage3c-capabilities-disabled-to-codex-enabled-false", () => {
    const caps = capabilitiesForSurfaceKind("codex-toml");
    const canonical = canonicalizeServerEntry({
      command: "node",
      args: ["x"],
      enabled: false,
    });
    const translated = translateCanonicalToTargetLogical("off", canonical, caps);
    expect(translated.ok).toBe(true);
    if (translated.ok) {
      expect(translated.logical.enabled).toBe(false);
    }
  });

  it("stage3c-expected-path-covers-all-client-ids", () => {
    for (const id of ALL_CLIENT_CONFIG_IDS) {
      const p = expectedClientConfigPath(id, cwd, { homedir: () => home });
      expect(p.length).toBeGreaterThan(0);
    }
  });

  function cliEnv(): Record<string, string> {
    return {
      HOME: home,
      USERPROFILE: home,
      APPDATA: process.env.APPDATA!,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME!,
    };
  }

  it("stage3c-sync-json-error-missing-target", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      a: { command: "node", args: ["STUB"] },
    });
    const windsurfPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");
    await mkdir(path.dirname(windsurfPath), { recursive: true });
    await writeFile(windsurfPath, "{ not-json", "utf8");

    const res = runCli(
      ["sync", "--from", "cursor-global", "--to", "windsurf", "--json", "--yes"],
      cwd,
      cliEnv()
    );
    expect(res.status).toBe(2);
    expect(res.stdout.trim().length).toBeGreaterThan(0);
    expect(res.stderr.trim()).toBe("");
    const body = JSON.parse(res.stdout) as { error: string; code: string; configPath?: string };
    expect(body.error).toMatch(/cannot read config/i);
    expect(body.code).toBe(SYNC_ERROR_CODES.TARGET_READ_FAILED);
    expect(body.configPath).toBe(windsurfPath);
  });

  it("stage3c-sync-json-error-unknown-client", async () => {
    const res = runCli(
      ["sync", "--from", "not-a-client", "--to", "windsurf", "--json"],
      cwd,
      cliEnv()
    );
    expect(res.status).toBe(2);
    const body = JSON.parse(res.stdout) as { error: string; code: string };
    expect(body.code).toBe(SYNC_ERROR_CODES.UNKNOWN_CLIENT);
    expect(body.error).toMatch(/Unknown client id/);
    expect(res.stderr.trim()).toBe("");
  });

  it("stage3c-sync-json-error-source-equals-target", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      a: { command: "node", args: ["STUB"] },
    });
    const res = runCli(
      ["sync", "--from", "cursor-global", "--to", "cursor-global", "--json"],
      cwd,
      cliEnv()
    );
    expect(res.status).toBe(2);
    const body = JSON.parse(res.stdout) as { error: string; code: string };
    expect(body.code).toBe(SYNC_ERROR_CODES.SOURCE_EQUALS_TARGET);
    expect(body.error).toMatch(/different clients/);
    expect(res.stderr.trim()).toBe("");
  });

  it("stage3c-sync-dry-run-previews-create-missing-target", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      one: { command: "node", args: ["STUB"] },
      two: { command: "node", args: ["STUB"] },
    });
    const windsurfPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");

    const result = await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "windsurf",
      dryRun: true,
      yes: true,
      json: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    expect(result.targets[0]?.created).toBe(true);
    expect(result.targets[0]?.configPath).toBe(windsurfPath);
    expect(result.targets[0]?.added.sort()).toEqual(["one", "two"]);
    await expect(readFile(windsurfPath, "utf8")).rejects.toThrow();
  });

  it("stage3c-sync-creates-missing-target-with-yes", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      only: { command: "node", args: ["STUB"] },
    });
    const windsurfPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");

    const result = await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "windsurf",
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    expect(result.applied).toBe(true);
    expect(result.targets[0]?.written).toBe(true);
    expect(result.targets[0]?.created).toBe(true);
    expect(result.targets[0]?.backupPath).toBeUndefined();
    const parsed = parseClientConfigContent(
      await readFile(windsurfPath, "utf8"),
      windsurfPath
    );
    expect(getServerNamesFromClientConfig(parsed, windsurfPath).has("only")).toBe(true);
    const backups = (await readdir(path.dirname(windsurfPath))).filter((f) =>
      f.includes(".bak-")
    );
    expect(backups).toHaveLength(0);
  });

  it("stage3c-sync-creates-missing-codex-toml-target", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      codexSrv: { command: "node", args: ["STUB"] },
    });
    const codexPath = path.join(getCodexHome(home, process.env), "config.toml");

    const result = await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "codex",
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    expect(result.targets[0]?.created).toBe(true);
    expect(result.targets[0]?.written).toBe(true);
    const text = await readFile(codexPath, "utf8");
    expect(text).toMatch(/codexSrv/);
    const parsed = parseClientConfigContent(text, codexPath);
    expect(getServerNamesFromClientConfig(parsed, codexPath).has("codexSrv")).toBe(true);
  });

  it("stage3c-sync-to-all-still-skips-missing", async () => {
    await seedClientConfig("cursor-global", home, cwd, {
      a: { command: "node", args: ["STUB"] },
    });
    await seedClientConfig("windsurf", home, cwd, {
      a: { command: "node", args: ["STUB"] },
    });

    const result = await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "all",
      dryRun: true,
      yes: true,
      cwd,
      detectDeps: { homedir: () => home, platform: () => process.platform },
    });

    expect(result.targets.some((t) => t.clientId === "windsurf")).toBe(true);
    expect(
      result.skippedClients.some((s) => s.clientId === "codex" && /not present/i.test(s.reason))
    ).toBe(true);
    const codexPath = path.join(getCodexHome(home, process.env), "config.toml");
    await expect(readFile(codexPath, "utf8")).rejects.toThrow();
  });

  it("stage3c-sync-home-resolution-matches-discovery", async () => {
    const userProfile = await mkdtemp(path.join(os.tmpdir(), "stage3c-userprofile-"));
    const homeOverride = await mkdtemp(path.join(os.tmpdir(), "stage3c-home-override-"));
    process.env.HOME = homeOverride;
    process.env.USERPROFILE = userProfile;
    process.env.APPDATA = path.join(userProfile, "AppData", "Roaming");

    const detectDeps = {
      platform: () => "win32" as NodeJS.Platform,
      homedir: () => userProfile,
      env: process.env,
    };

    await seedClientConfig("cursor-global", userProfile, cwd, {
      only: { command: "node", args: ["STUB"] },
    });
    await seedClientConfig("windsurf", userProfile, cwd, {
      only: { command: "node", args: ["STUB"] },
      extra: { command: "node", args: ["STUB"] },
    });

    const detected = await detectClientConfigs(cwd, detectDeps);
    const byId = new Map(detected.map((c) => [c.id, c]));

    for (const id of ["cursor-global", "windsurf"] as const) {
      const fromDiscover = byId.get(id)?.path;
      const fromExpected = expectedClientConfigPath(id, cwd, detectDeps);
      expect(fromExpected).toBe(fromDiscover);
      expect(fromExpected).not.toContain(homeOverride);
    }

    const result = await syncMcpClients({
      fromClientId: "cursor-global",
      toClientId: "windsurf",
      dryRun: true,
      yes: true,
      cwd,
      detectDeps,
    });
    expect(result.sourceConfigPath).toBe(byId.get("cursor-global")!.path);
    expect(result.targets[0]?.configPath).toBe(byId.get("windsurf")!.path);
  });
});
