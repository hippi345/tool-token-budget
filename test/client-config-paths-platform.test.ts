import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import {
  detectClientConfigs,
  getAppDataDirFor,
} from "../src/discover/clientConfigs.js";

describe("client config paths per platform (injected home)", () => {
  it("macOS Application Support paths for Claude Desktop and VS Code user", async () => {
    const home = path.join(os.tmpdir(), "fake-macos-home");
    const appData = getAppDataDirFor("darwin", home, {});
    expect(appData).toBe(path.join(home, "Library", "Application Support"));

    const cwd = await mkdtemp(path.join(os.tmpdir(), "mac-cwd-"));
    const claudePath = path.join(appData, "Claude", "claude_desktop_config.json");
    const vscodePath = path.join(appData, "Code", "User", "mcp.json");
    await mkdir(path.dirname(claudePath), { recursive: true });
    await mkdir(path.dirname(vscodePath), { recursive: true });
    await writeFile(claudePath, '{"mcpServers":{}}\n', "utf8");
    await writeFile(vscodePath, '{"servers":{}}\n', "utf8");

    const configs = await detectClientConfigs(cwd, {
      homedir: () => home,
      platform: () => "darwin",
      env: {},
    });
    const ids = configs.map((c) => c.id);
    expect(ids).toContain("claude-desktop");
    expect(ids).toContain("vscode-user");
    expect(configs.find((c) => c.id === "claude-desktop")!.path).toBe(claudePath);
    await rm(cwd, { recursive: true, force: true });
  });

  it("Windows APPDATA paths for Claude Desktop", async () => {
    const home = path.join(os.tmpdir(), "fake-win-home");
    const appData = path.join(home, "AppData", "Roaming");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "win-cwd-"));
    const claudePath = path.join(appData, "Claude", "claude_desktop_config.json");
    await mkdir(path.dirname(claudePath), { recursive: true });
    await writeFile(claudePath, '{"mcpServers":{}}\n', "utf8");

    const configs = await detectClientConfigs(cwd, {
      homedir: () => home,
      platform: () => "win32",
      env: { APPDATA: appData },
    });
    expect(configs.some((c) => c.id === "claude-desktop" && c.path === claudePath)).toBe(true);
    await rm(cwd, { recursive: true, force: true });
  });

  it("stage2-item5-windows-vscode-user-mcp-appdata", async () => {
    const home = path.join(os.tmpdir(), "fake-win-home-stage2");
    const appData = path.join(home, "AppData", "Roaming");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "win-vscode-cwd-"));
    const vscodePath = path.join(appData, "Code", "User", "mcp.json");
    await mkdir(path.dirname(vscodePath), { recursive: true });
    await writeFile(vscodePath, '{"servers":{}}\n', "utf8");

    const configs = await detectClientConfigs(cwd, {
      homedir: () => home,
      platform: () => "win32",
      env: { APPDATA: appData, USERPROFILE: home },
    });
    const vscode = configs.find((c) => c.id === "vscode-user");
    expect(vscode?.path).toBe(vscodePath);
    expect(vscode?.viewOnly).toBe(false);
    await rm(cwd, { recursive: true, force: true });
  });

  it("stage2-item5-darwin-vscode-user-mcp", async () => {
    const home = path.join(os.tmpdir(), "fake-macos-vscode");
    const appData = getAppDataDirFor("darwin", home, {});
    const cwd = await mkdtemp(path.join(os.tmpdir(), "mac-vscode-cwd-"));
    const vscodePath = path.join(appData, "Code", "User", "mcp.json");
    await mkdir(path.dirname(vscodePath), { recursive: true });
    await writeFile(vscodePath, '{"servers":{}}\n', "utf8");
    const configs = await detectClientConfigs(cwd, {
      homedir: () => home,
      platform: () => "darwin",
      env: {},
    });
    expect(configs.some((c) => c.id === "vscode-user" && c.path === vscodePath)).toBe(
      true
    );
    await rm(cwd, { recursive: true, force: true });
  });

  it("stage2-item5-linux-vscode-user-mcp-xdg", async () => {
    const home = path.join(os.tmpdir(), "fake-linux-vscode");
    const xdg = path.join(home, ".config");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "linux-vscode-cwd-"));
    const vscodePath = path.join(xdg, "Code", "User", "mcp.json");
    await mkdir(path.dirname(vscodePath), { recursive: true });
    await writeFile(vscodePath, '{"servers":{}}\n', "utf8");
    const configs = await detectClientConfigs(cwd, {
      homedir: () => home,
      platform: () => "linux",
      env: { XDG_CONFIG_HOME: xdg },
    });
    expect(configs.some((c) => c.id === "vscode-user" && c.path === vscodePath)).toBe(
      true
    );
    await rm(cwd, { recursive: true, force: true });
  });

  it("stage2-item5-windows-windsurf-userprofile", async () => {
    const home = path.join(os.tmpdir(), "fake-win-windsurf");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "win-windsurf-cwd-"));
    const windsurfPath = path.join(home, ".codeium", "windsurf", "mcp_config.json");
    await mkdir(path.dirname(windsurfPath), { recursive: true });
    await writeFile(windsurfPath, '{"mcpServers":{}}\n', "utf8");
    const configs = await detectClientConfigs(cwd, {
      homedir: () => home,
      platform: () => "win32",
      env: { USERPROFILE: home },
    });
    expect(configs.some((c) => c.id === "windsurf" && c.path === windsurfPath)).toBe(
      true
    );
    await rm(cwd, { recursive: true, force: true });
  });

  it("Linux XDG config paths for Claude Desktop", async () => {
    const home = path.join(os.tmpdir(), "fake-linux-home");
    const xdg = path.join(home, ".config");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "linux-cwd-"));
    const claudePath = path.join(xdg, "Claude", "claude_desktop_config.json");
    await mkdir(path.dirname(claudePath), { recursive: true });
    await writeFile(claudePath, '{"mcpServers":{}}\n', "utf8");

    const configs = await detectClientConfigs(cwd, {
      homedir: () => home,
      platform: () => "linux",
      env: { XDG_CONFIG_HOME: xdg },
    });
    expect(configs.some((c) => c.id === "claude-desktop" && c.path === claudePath)).toBe(true);
    await rm(cwd, { recursive: true, force: true });
  });
});
