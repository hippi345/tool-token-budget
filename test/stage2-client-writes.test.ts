import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { applyConfig } from "../src/apply/applyConfig.js";
import { discoverFromMcpConfig } from "../src/discover/fromMcpConfig.js";
import { analyzeTools } from "../src/pipeline.js";
import { buildClientProposedMcpConfig } from "../src/emit/writeArtifacts.js";
import { toolKey } from "../src/emit/keepHot.js";
import { writeAdjacentEmitReport } from "./apply-report-helper.js";
import {
  detectClientConfigs,
  getAppDataDirFor,
} from "../src/discover/clientConfigs.js";
import {
  getServerNamesFromClientConfig,
  mergeProposedOntoClientConfig,
  parseClientConfigContent,
} from "../src/config/configSurfaces.js";
import { computeConfigContentHash } from "../src/mcp/configGuards.js";
import { startServer } from "../src/ui/server.js";
import type { Report } from "../src/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");

async function copyFixtureToTemp(
  relFixture: string,
  targetRelPath?: string
): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stage2-"));
  const rel = targetRelPath ?? path.basename(relFixture);
  const configPath = path.join(dir, rel);
  await mkdir(path.dirname(configPath), { recursive: true });
  await copyFile(path.join(repoRoot, relFixture), configPath);
  let content = await readFile(configPath, "utf8");
  content = content.replace(/fixtures\/stub-mcp-server\.mjs/g, stub);
  await writeFile(configPath, content, "utf8");
  return { dir, configPath };
}

async function roundTripClient(
  relFixture: string,
  targetName?: string,
  serverToRemove = "gamma"
): Promise<void> {
  const { dir, configPath } = await copyFixtureToTemp(relFixture, targetName);
  try {
    const { tools, servers } = await discoverFromMcpConfig(configPath, {
      timeoutMs: 20_000,
    });
    const report = analyzeTools(tools, servers);
    const hot = new Set(report.tools.map((m) => toolKey(m.server, m.name)));
    const disabled = new Set<string>([serverToRemove]);
    const { proposed } = buildClientProposedMcpConfig(
      configPath,
      parseClientConfigContent(await readFile(configPath, "utf8"), configPath),
      hot,
      disabled,
      report.tools,
      { report }
    );
    const proposedPath = path.join(dir, "proposed.json");
    await writeFile(proposedPath, JSON.stringify(proposed, null, 2) + "\n", "utf8");
    await writeAdjacentEmitReport(proposedPath, configPath, [serverToRemove]);

    const dry = await applyConfig({
      mcpConfigPath: configPath,
      proposedPath,
      dryRun: true,
      backup: false,
      yes: false,
    });
    expect(dry.success).toBe(true);
    expect(dry.diffSummary?.serversRemoved).toContain(serverToRemove);

    const live = await applyConfig({
      mcpConfigPath: configPath,
      proposedPath,
      dryRun: false,
      backup: true,
      yes: true,
    });
    expect(live.success).toBe(true);

    const after = parseClientConfigContent(
      await readFile(configPath, "utf8"),
      configPath
    );
    const names = getServerNamesFromClientConfig(after, configPath);
    expect(names.has(serverToRemove)).toBe(false);
    expect(names.has("alpha")).toBe(true);

    const rediscover = await discoverFromMcpConfig(configPath, { timeoutMs: 20_000 });
    expect(rediscover.servers.some((s) => s.name === serverToRemove)).toBe(false);
    expect(rediscover.servers.some((s) => s.name === "alpha")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Stage 2 — client write support", () => {
  it("stage2-item-guard-no-real-home", async () => {
    const realHome = process.env.__TEST_REAL_HOME || process.env.REAL_HOME;
    expect(realHome).toBeTruthy();
    expect(path.normalize(os.homedir())).not.toBe(path.normalize(realHome));
    const clients = await detectClientConfigs(process.cwd());
    const normalizedRealHome = path.normalize(realHome);
    for (const client of clients) {
      expect(path.normalize(client.path)).not.toContain(normalizedRealHome);
    }
  });

  it("stage2-adapter-vscode-injects-stdio-type", () => {
    const merged = mergeProposedOntoClientConfig(
      { servers: {} },
      "mcp.json",
      {
        mcpServers: {
          s: { command: "node", args: [] },
        },
      }
    ) as { servers: Record<string, { type?: string }> };
    expect(merged.servers.s.type).toBe("stdio");
  });

  it("stage2-item1-vscode-workspace-round-trip", async () => {
    await roundTripClient("fixtures/clients/vscode/workspace-mcp.json", "mcp.json");
  });

  it("stage2-item1-windsurf-round-trip", async () => {
    await roundTripClient("fixtures/clients/windsurf/mcp_config.json");
  });

  it("stage2-item1-gemini-settings-round-trip", async () => {
    await roundTripClient(
      "fixtures/clients/gemini/settings.jsonc",
      ".gemini/settings.json",
      "beta"
    );
  });

  it("stage2-item1-antigravity-round-trip", async () => {
    await roundTripClient("fixtures/clients/antigravity/mcp_config.json", undefined, "beta");
  });

  it("stage2-item2-vscode-settings-jsonc-preserves-comments", async () => {
    const golden = await readFile(
      path.join(repoRoot, "fixtures/clients/vscode/user-settings.jsonc"),
      "utf8"
    );
    const { dir, configPath } = await copyFixtureToTemp(
      "fixtures/clients/vscode/user-settings.jsonc",
      "Code/User/settings.json"
    );
    try {
      const parsed = parseClientConfigContent(golden, configPath);
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
      expect(after).toContain("// VS Code user MCP (JSONC)");
      expect(after).toContain('"editor.fontSize": 14');
      expect(after).toContain('"workbench.colorTheme": "Default Dark+"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stage2-item3-secrets-restored-from-backup-on-apply", async () => {
    const { dir, configPath } = await copyFixtureToTemp(
      "fixtures/clients/vscode/workspace-mcp-secrets.json",
      "mcp.json"
    );
    try {
      const originalText = await readFile(configPath, "utf8");
      const parsed = parseClientConfigContent(originalText, configPath);
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
      const proposedStr = JSON.stringify(proposed);
      expect(proposedStr).toContain("<from-original>");
      const proposedPath = path.join(dir, "proposed.json");
      await writeFile(proposedPath, proposedStr + "\n", "utf8");
      await writeAdjacentEmitReport(proposedPath, configPath, []);

      const applied = await applyConfig({
        mcpConfigPath: configPath,
        proposedPath,
        dryRun: false,
        backup: true,
        yes: true,
      });
      expect(applied.success).toBe(true);
      const live = await readFile(configPath, "utf8");
      expect(live).toContain("super-secret-token-value");
      expect(live).not.toContain("<from-original>");
      if (applied.backupPath) {
        const backup = await readFile(applied.backupPath, "utf8");
        expect(backup).toBe(originalText);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stage2-item4-concurrent-apply-serialized", async () => {
    const { dir, configPath } = await copyFixtureToTemp(
      "fixtures/clients/windsurf/mcp_config.json"
    );
    const originalBytes = await readFile(configPath, "utf8");
    const proposedPath = path.join(dir, "proposed.json");
    const proposed = JSON.parse(originalBytes) as { mcpServers: Record<string, unknown> };
    delete proposed.mcpServers.gamma;
    await writeFile(proposedPath, JSON.stringify(proposed, null, 2) + "\n", "utf8");
    await writeFile(
      path.join(dir, "report.json"),
      JSON.stringify(
        {
          savings: { removedServers: ["gamma"] },
          sourceConfigHash: computeConfigContentHash(originalBytes),
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    try {
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          applyConfig({
            mcpConfigPath: configPath,
            proposedPath,
            dryRun: false,
            backup: true,
            yes: true,
          })
        )
      );
      expect(results.filter((r) => r.success)).toHaveLength(1);
      expect(results.filter((r) => !r.success)).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stage2-ui-servers-export-windsurf-client", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "stage2-ui-"));
    const windsurfDir = path.join(os.homedir(), ".codeium", "windsurf");
    await mkdir(windsurfDir, { recursive: true });
    const windsurfPath = path.join(windsurfDir, "mcp_config.json");
    await copyFile(
      path.join(repoRoot, "fixtures/clients/windsurf/mcp_config.json"),
      windsurfPath
    );
    let content = await readFile(windsurfPath, "utf8");
    content = content.replace(/fixtures\/stub-mcp-server\.mjs/g, stub);
    await writeFile(windsurfPath, content, "utf8");

    const exportRoot = path.join(testDir, "exports");
    await mkdir(exportRoot, { recursive: true });

    const mockReport: Report = {
      generatedAt: new Date().toISOString(),
      tokenizerId: "o200k_base",
      totals: { estTokens: 10, toolCount: 2, serverCount: 2, findingCount: 0 },
      tools: [
        {
          server: "alpha",
          name: "ping",
          estTokens: 5,
          breakdown: { name: 1, description: 1, schema: 3 },
          shareOfServer: 1,
          shareOfAll: 1,
        },
      ],
      servers: [{ name: "alpha", status: "ok" }],
      findings: [],
    };

    let serverPort = 0;
    const server = await startServer({
      cwd: testDir,
      configPath: windsurfPath,
      exportDir: exportRoot,
      getReport: () => mockReport,
      onReady: (url) => {
        serverPort = parseInt(new URL(url).port, 10);
      },
    });

    try {
      const clients = await detectClientConfigs(testDir);
      const windsurf = clients.find((c) => c.id === "windsurf");
      expect(windsurf?.viewOnly).toBe(false);
      expect(windsurf?.path).toBe(windsurfPath);

      expect(serverPort).toBeGreaterThan(0);
      const origin = `http://127.0.0.1:${serverPort}`;
      const res = await fetch(`${origin}/api/export`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "X-Auth-Token": server.token,
        },
        body: JSON.stringify({
          clientId: "windsurf",
          policy: { keepPerServer: 2 },
        }),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { written: string[] };
      expect(
        data.written.some((p) => p.includes("mcp_config.json.tool-token-budget-proposed.json"))
      ).toBe(true);
    } finally {
      await server.close();
      await rm(windsurfPath, { force: true }).catch(() => {});
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
