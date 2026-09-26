import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { startServer } from "../src/ui/server.js";
import type { Report } from "../src/types.js";
import {
  shouldShowApplyPreviewError,
  reconcileApplySectionOnConfigHealth,
} from "../gui/src/configHealthUi.ts";
import { isSerializedDiffEmpty } from "../gui/src/snapshotDiff.ts";
import {
  detectClientConfigs,
  settingsJsonHasLegacyMcpServers,
  stripJsoncComments,
} from "../src/discover/clientConfigs.js";
import { formatTextReport } from "../src/report/formatText.js";
import { formatHtml } from "../src/report/formatHtml.js";
import type { Report as HtmlReport } from "../src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "dist", "cli.js");

const mockReport: Report = {
  generatedAt: new Date().toISOString(),
  tokenizerId: "o200k_base",
  totals: { estTokens: 10, toolCount: 1, serverCount: 1, findingCount: 0 },
  tools: [
    {
      server: "s",
      name: "t",
      estTokens: 10,
      breakdown: { name: 1, description: 1, schema: 8 },
      shareOfServer: 1,
      shareOfAll: 1,
    },
  ],
  servers: [{ name: "s", status: "ok" }],
  findings: [],
};

const REBRAND_ALLOWLIST = [
  "tool-token-budget-export",
  "tool-token-budget-proposed",
  "tool-token-budget-theme",
  "tool-token-budget/",
  "tool-token-budget.lock",
  "schema-budget-export",
  "schema-budget-proposed",
  "schema-budget.keep",
  "tool-token-budget.keep",
  "schema-budget-theme",
  "schema-budget`",
  'schema-budget"',
  "schema-budget:",
  "schema-budget ",
  "schema-budget/",
  "schema-budget.lock",
  "tool-token-budget-demo",
  "schema-budget-design",
  "schema-budget.sarif",
  "schema-budget analyze",
  "schema-budget emit",
  "schema-budget apply",
  "schema-budget ui",
  "bin alias",
  "backward-compatible alias",
  "name: \"schema-budget\"",
  'name: "schema-budget"',
];

function walkTsFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir)) {
    const full = path.join(dir, ent);
    if (statSync(full).isDirectory()) {
      if (ent === "node_modules" || ent === "dist") continue;
      out.push(...walkTsFiles(full, base));
    } else if (/\.(ts|tsx|md)$/.test(ent)) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

function isAllowedUserFacingLine(line: string): boolean {
  if (!/\bschema-budget\b|\bSchema Budget\b/i.test(line)) {
    return true;
  }
  return REBRAND_ALLOWLIST.some((frag) => line.includes(frag));
}

describe("PR #20 items", () => {
  it("pr20-item01 hides apply preview error when configLoadError is set", () => {
    expect(
      shouldShowApplyPreviewError("Config file cannot be read: bad json", "JSON syntax error")
    ).toBe(false);
    expect(shouldShowApplyPreviewError("other error", null)).toBe(true);
    expect(reconcileApplySectionOnConfigHealth("err").clearExportResult).toBe(true);
  });

  describe("pr20-item02 export body validation", () => {
    let server: Awaited<ReturnType<typeof startServer>>;
    let port: number;
    let testDir: string;

    beforeAll(async () => {
      testDir = await mkdtemp(path.join(os.tmpdir(), "pr20-export-body-"));
      const cursorDir = path.join(testDir, ".cursor");
      await mkdir(cursorDir, { recursive: true });
      const mcpPath = path.join(cursorDir, "mcp.json");
      await writeFile(mcpPath, '{"mcpServers":{"s":{"command":"node","args":[]}}}\n', "utf8");

      server = await startServer({
        cwd: testDir,
        configPath: mcpPath,
        getReport: () => mockReport,
        onReady: (url) => {
          port = parseInt(new URL(url).port, 10);
        },
      });
    });

    afterAll(async () => {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    });

    async function postExportBody(body: string) {
      return fetch(`http://127.0.0.1:${port}/api/export`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: `http://127.0.0.1:${port}`,
        },
        body,
      });
    }

    for (const [label, body] of [
      ["null", "null"],
      ["number", "5"],
      ["array", "[]"],
      ["string", '"hello"'],
    ] as const) {
      it(`rejects ${label} JSON body with 400`, async () => {
        const res = await postExportBody(body);
        expect(res.status).toBe(400);
        expect(await res.text()).toBe("Bad Request: body must be a JSON object");
      });
    }
  });

  it("pr20-item03a Editor shows empty state when report has no servers", async () => {
    const editor = await readFile(path.join(repoRoot, "gui", "src", "Editor.tsx"), "utf8");
    expect(editor).toMatch(/servers\.length === 0/);
    expect(editor).toMatch(/No MCP servers in the current config/);
    expect(editor).toMatch(/proposal && servers\.length > 0/);
  });

  it("pr20-item03b preview returns distinct message when config has no servers", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "pr20-no-servers-"));
    const cursorDir = path.join(testDir, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    const mcpPath = path.join(cursorDir, "mcp.json");
    await writeFile(mcpPath, '{"mcpServers":{}}\n', "utf8");

    const emptyReport: Report = {
      ...mockReport,
      totals: { estTokens: 0, toolCount: 0, serverCount: 0, findingCount: 0 },
      tools: [],
      servers: [],
    };

    const server = await startServer({
      cwd: testDir,
      configPath: mcpPath,
      getReport: () => emptyReport,
      onReady: () => {},
    });
    const port = parseInt(new URL(server.url).port, 10);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/apply/preview`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ policy: {}, clientId: "cursor-project" }),
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toBe("Unprocessable: no servers in config");
    } finally {
      await server.close();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("pr20-item03c config health reconcile clears export success message", () => {
    expect(reconcileApplySectionOnConfigHealth("broken").clearExportResult).toBe(true);
  });

  it("pr20-item03d export errors render beside Export button", async () => {
    const editor = await readFile(path.join(repoRoot, "gui", "src", "Editor.tsx"), "utf8");
    expect(editor).toContain("exportError");
    expect(editor).toMatch(/export-section[\s\S]*exportError/);
    expect(editor).toContain("setExportError");
  });

  it("pr20-item04 dedupes cursor-global and cursor-project when paths resolve the same", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "pr20-home-"));
    const cursorDir = path.join(home, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    const mcpPath = path.join(cursorDir, "mcp.json");
    await writeFile(mcpPath, '{"mcpServers":{}}\n', "utf8");

    const configs = await detectClientConfigs(home, {
      homedir: () => home,
      platform: () => "linux",
      env: {},
    });
    expect(configs.filter((c) => c.id.startsWith("cursor")).length).toBe(1);

    const winConfigs = await detectClientConfigs(home, {
      homedir: () => home,
      platform: () => "win32",
      env: { APPDATA: path.join(home, "AppData", "Roaming") },
    });
    expect(winConfigs.filter((c) => c.id.startsWith("cursor")).length).toBe(1);

    await rm(home, { recursive: true, force: true });
  });

  it("pr20-item05 skips empty serialized diffs for Live Changes feed", () => {
    const empty = {
      servers: { added: [], removed: [], statusChanged: [] },
      tools: { added: [], removed: [], changed: [] },
      tokens: { total: 0, perServer: {} },
    };
    expect(isSerializedDiffEmpty(empty)).toBe(true);
    expect(
      isSerializedDiffEmpty({
        ...empty,
        servers: { ...empty.servers, added: ["x"] },
      })
    ).toBe(false);
    const app = readFileSync(path.join(repoRoot, "gui", "src", "App.tsx"), "utf8");
    expect(app).toContain("isSerializedDiffEmpty");
  });

  it("pr20-item06 lint-server Cannot load includes file name", () => {
    const result = spawnSync("node", [CLI, "lint-server", "--tools-json", "missing-tools.json"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Cannot load missing-tools.json:");
  });

  it("pr20-item08 globalSetup records real home only once", async () => {
    const mod = await import("./setup/globalSetup.ts");
    const prevReal = process.env.__TEST_REAL_HOME;
    const prevHome = process.env.HOME;
    delete process.env.__TEST_REAL_HOME;
    delete process.env.REAL_HOME;
    mod.default();
    const first = process.env.__TEST_REAL_HOME;
    mod.default();
    const second = process.env.__TEST_REAL_HOME;
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    if (prevReal) process.env.__TEST_REAL_HOME = prevReal;
    if (prevHome) process.env.HOME = prevHome;
  });

  it("pr20-item10 item-55 uses one shared UI server per watch/poll mode", async () => {
    const src = await readFile(path.join(repoRoot, "test", "item-55-bad-config-shape.test.ts"), "utf8");
    expect(src).toContain("shared server");
    expect(src).toContain("beforeAll");
  });

  it("pr20-item09 playwright-loader forwards extra CLI args", () => {
    const loader = readFileSync(path.join(repoRoot, "test", "e2e", "playwright-loader.cjs"), "utf8");
    expect(loader).toContain("playwrightExtraArgs");
    expect(loader).toContain("...playwrightExtraArgs");
  });

  it("pr20-item11 analyze text and HTML report use Tool Token Budget branding", () => {
    const mini: HtmlReport = {
      generatedAt: "2026-01-01T00:00:00Z",
      tokenizerId: "o200k_base",
      totals: { estTokens: 1, toolCount: 1, serverCount: 1, findingCount: 0 },
      tools: mockReport.tools,
      servers: mockReport.servers,
      findings: [],
    };
    expect(formatTextReport(mini)).toContain("tool-token-budget - MCP schema token estimates");
    const html = formatHtml(mini);
    expect(html).toContain("<title>Tool Token Budget report</title>");
    expect(html).toContain("<h1>Tool Token Budget</h1>");
  });

  it("pr20-item12 README has no stale Schema Budget branding outside alias", async () => {
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    const withoutAliasLine = readme
      .split("\n")
      .filter((line) => !line.includes("schema-budget` bin alias"))
      .join("\n");
    expect(withoutAliasLine).not.toMatch(/Schema Budget/i);
    expect(withoutAliasLine).not.toMatch(/npm install -g schema-budget/);
    expect(readme).toMatch(/schema-budget.*bin alias/i);
  });

  it("pr20-item13 workflow file uses tool-token-budget labels", async () => {
    const wf = await readFile(
      path.join(repoRoot, ".github", "workflows", "tool-token-budget.yml"),
      "utf8"
    );
    expect(wf).toContain("Build tool-token-budget");
    expect(wf).toContain("Tool Token Budget Report");
    expect(wf).not.toContain("name: Build schema-budget");
  });

  it("pr20-item14 demo GIF, tape, and README use tool-token-budget-demo name", async () => {
    const tape = await readFile(path.join(repoRoot, "demos", "tape.tape"), "utf8");
    expect(tape).toContain("Tool Token Budget");
    expect(tape).not.toMatch(/# Schema Budget Demo/);
    expect(tape).toContain("tool-token-budget-demo.gif");
    expect(tape).toContain("tool-token-budget analyze");
    expect(tape).not.toContain("schema-budget-demo.gif");

    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain("demos/tool-token-budget-demo.gif");
    expect(readme).not.toContain("schema-budget-demo.gif");

    const gifPath = path.join(repoRoot, "demos", "tool-token-budget-demo.gif");
    const { statSync } = await import("node:fs");
    const st = statSync(gifPath);
    expect(st.size).toBeGreaterThan(10_000);
  });

  it("pr20-item15 gui workspace package name is tool-token-budget-gui", async () => {
    const pkg = JSON.parse(
      await readFile(path.join(repoRoot, "gui", "package.json"), "utf8")
    ) as { name: string };
    expect(pkg.name).toBe("tool-token-budget-gui");
    const lock = await readFile(path.join(repoRoot, "package-lock.json"), "utf8");
    expect(lock).toContain("tool-token-budget-gui");
  });

  it("pr20-item16 applyConfig errors mention tool-token-budget emit", async () => {
    const src = await readFile(path.join(repoRoot, "src", "apply", "applyConfig.ts"), "utf8");
    expect(src).toContain("tool-token-budget emit");
    expect(src).not.toMatch(/Re-run schema-budget emit/);
  });

  it("pr20-item17 docs VS Code user row documents mcp.json only", async () => {
    const doc = await readFile(path.join(repoRoot, "docs", "client-config-paths.md"), "utf8");
    const vscodeUserLine = doc.split("\n").find((l) => l.includes("**VS Code**") && l.includes("User"));
    expect(vscodeUserLine).toBeTruthy();
    expect(vscodeUserLine!).toMatch(/mcp\.json/);
    expect(vscodeUserLine!).not.toMatch(/settings\.json/);
  });

  it("pr20-item18 legacy VS Code settings.json mcp.servers discovery (JSONC)", async () => {
    const jsonc = stripJsoncComments(`{
      // comment
      "mcp": {
        "servers": { "a": {} }
      }
    }`);
    const parsed = JSON.parse(jsonc);
    expect(parsed.mcp.servers).toBeTruthy();

    const home = await mkdtemp(path.join(os.tmpdir(), "pr20-vscode-"));
    const appData = path.join(home, "Library", "Application Support");
    const userDir = path.join(appData, "Code", "User");
    await mkdir(userDir, { recursive: true });
    const settingsPath = path.join(userDir, "settings.json");
    await writeFile(
      settingsPath,
      `{\n  // legacy\n  "mcp": { "servers": { "srv": { "type": "stdio" } } }\n}\n`,
      "utf8"
    );
    expect(await settingsJsonHasLegacyMcpServers(settingsPath)).toBe(true);

    const darwinCwd = await mkdtemp(path.join(os.tmpdir(), "pr20-darwin-"));
    const darwinConfigs = await detectClientConfigs(darwinCwd, {
      homedir: () => home,
      platform: () => "darwin",
      env: {},
    });
    expect(darwinConfigs.some((c) => c.id === "vscode-user" && c.path === settingsPath)).toBe(
      true
    );

    const winHome = await mkdtemp(path.join(os.tmpdir(), "pr20-win-"));
    const winAppData = path.join(winHome, "AppData", "Roaming");
    await mkdir(path.join(winAppData, "Code", "User"), { recursive: true });
    await writeFile(
      path.join(winAppData, "Code", "User", "settings.json"),
      '{"mcp":{"servers":{"x":{}}}}\n',
      "utf8"
    );
    const winCwd = await mkdtemp(path.join(os.tmpdir(), "pr20-wincwd-"));
    const winConfigs = await detectClientConfigs(winCwd, {
      homedir: () => winHome,
      platform: () => "win32",
      env: { APPDATA: winAppData },
    });
    expect(winConfigs.some((c) => c.id === "vscode-user")).toBe(true);

    const linuxHome = await mkdtemp(path.join(os.tmpdir(), "pr20-linux-"));
    const linuxConfig = path.join(linuxHome, ".config", "Code", "User");
    await mkdir(linuxConfig, { recursive: true });
    const linuxSettings = path.join(linuxConfig, "settings.json");
    await writeFile(linuxSettings, '{"mcp":{"servers":{"z":{}}}}\n', "utf8");
    const linuxCwd = await mkdtemp(path.join(os.tmpdir(), "pr20-lxcwd-"));
    const linuxConfigs = await detectClientConfigs(linuxCwd, {
      homedir: () => linuxHome,
      platform: () => "linux",
      env: { XDG_CONFIG_HOME: path.join(linuxHome, ".config") },
    });
    expect(linuxConfigs.some((c) => c.id === "vscode-user" && c.path === linuxSettings)).toBe(
      true
    );

    await rm(darwinCwd, { recursive: true, force: true });
    await rm(winHome, { recursive: true, force: true });
    await rm(winCwd, { recursive: true, force: true });
    await rm(linuxHome, { recursive: true, force: true });
    await rm(linuxCwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("pr20-item19 vitest 5 with migrated pool options", async () => {
    const cfg = await readFile(path.join(repoRoot, "vitest.config.ts"), "utf8");
    expect(cfg).not.toContain("poolOptions");
    expect(cfg).toContain("maxWorkers: 1");
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies.vitest).toMatch(/^5\./);
  });

  it("pr20-item16b repo-wide user-facing rebrand allowlist", () => {
    const roots = [
      path.join(repoRoot, "src"),
      path.join(repoRoot, "gui", "src"),
    ];
    const files = [
      "README.md",
      ...roots.flatMap((r) => walkTsFiles(r, repoRoot)),
    ];
    for (const rel of files) {
      const text = readFileSync(path.join(repoRoot, rel), "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        expect(
          isAllowedUserFacingLine(lines[i]),
          `${rel}:${i + 1}: ${lines[i].trim()}`
        ).toBe(true);
      }
    }
  });
});
