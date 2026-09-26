import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  defaultProposedFilename,
  defaultExportDirForCwd,
  resolveProposedPathForApply,
  lockPathForConfig,
  legacyLockPathForConfig,
  readThemePreferenceFromStorage,
  isUiWatchDisabled,
  SARIF_TOOL_NAME,
  sarifRuleId,
  TOOL_TOKEN_BUDGET_EXPORT_DIR,
} from "../src/branding/artifactPaths.js";
import { proposedExportFilenameForClient } from "../src/config/configSurfaces.js";
import { formatSarif } from "../src/report/formatSarif.js";
import { formatHtml } from "../src/report/formatHtml.js";
import { withApplyFileLock, ApplyLockError } from "../src/apply/applyLock.js";
import type { Report } from "../src/types.js";
import { writeArtifacts } from "../src/emit/writeArtifacts.js";
import { previewTokenTtlMs } from "../src/ui/previewTokenStore.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(repoRoot, "dist", "cli.js");

describe("stage3a branding paths", () => {
  it("stage3a-default-proposed-filename-in-config-surfaces", () => {
    expect(
      proposedExportFilenameForClient({ path: "/x/mcp.json", profile: "cursor" })
    ).toBe(defaultProposedFilename());
  });

  it("stage3a-emit-writes-tool-token-budget-proposed-json", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "stage3a-prop-"));
    const report: Report = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      tokenizerId: "o200k_base",
      totals: { estTokens: 1, toolCount: 1, serverCount: 1, findingCount: 0 },
      tools: [
        {
          server: "s",
          name: "t",
          estTokens: 1,
          breakdown: { name: 1, description: 0, schema: 0 },
          shareOfServer: 1,
          shareOfAll: 1,
        },
      ],
      servers: [{ name: "s", status: "ok" }],
      findings: [],
    };
    await writeArtifacts(outDir, report, {
      format: "both",
      policy: { keepHot: 1 },
      originalConfig: { mcpServers: { s: { command: "node", args: [] } } },
    });
    await readFile(path.join(outDir, defaultProposedFilename()), "utf8");
    await rm(outDir, { recursive: true, force: true });
  });

  it("stage3a-apply-resolve-finds-legacy-proposed-sibling", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stage3a-legacy-prop-"));
    const mcp = path.join(dir, "mcp.json");
    await writeFile(mcp, '{"mcpServers":{}}\n', "utf8");
    await writeFile(
      path.join(dir, "mcp.json.schema-budget-proposed.json"),
      '{"mcpServers":{}}\n',
      "utf8"
    );
    const resolved = await resolveProposedPathForApply(mcp);
    expect(resolved).toContain("schema-budget-proposed");
    await rm(dir, { recursive: true, force: true });
  });

  it("stage3a-default-export-dir-name", () => {
    expect(defaultExportDirForCwd("/tmp/work")).toBe(
      path.join("/tmp/work", TOOL_TOKEN_BUDGET_EXPORT_DIR)
    );
  });

  it("stage3a-legacy-apply-lock-blocks-new-lock", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "stage3a-lock-"));
    const mcp = path.join(dir, "mcp.json");
    await writeFile(mcp, "{}\n", "utf8");
    const legacy = legacyLockPathForConfig(mcp);
    await writeFile(legacy, '{"pid":1}\n', "utf8");
    await expect(
      withApplyFileLock(mcp, async () => "ok")
    ).rejects.toBeInstanceOf(ApplyLockError);
    await rm(dir, { recursive: true, force: true });
  });

  it("stage3a-new-apply-lock-path-suffix", () => {
    expect(lockPathForConfig("/a/mcp.json")).toBe("/a/mcp.json.tool-token-budget.lock");
  });

  it("stage3a-gui-theme-storage-migrates-legacy-key", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    };
    storage.setItem("schema-budget-theme", "dark");
    expect(readThemePreferenceFromStorage(storage)).toBe("dark");
    expect(storage.getItem("tool-token-budget-theme")).toBe("dark");
    expect(storage.getItem("schema-budget-theme")).toBeNull();
  });

  it("stage3a-ui-no-watch-env-primary-and-legacy-fallback", () => {
    expect(isUiWatchDisabled({ TOOL_TOKEN_BUDGET_UI_NO_WATCH: "1" })).toBe(true);
    expect(isUiWatchDisabled({ SCHEMA_BUDGET_UI_NO_WATCH: "1" })).toBe(true);
    expect(isUiWatchDisabled({})).toBe(false);
  });

  it("stage3a-preview-token-ttl-env-primary-and-legacy-fallback", () => {
    expect(previewTokenTtlMs({})).toBe(15 * 60 * 1000);
    expect(
      previewTokenTtlMs({ SCHEMA_BUDGET_PREVIEW_TOKEN_TTL_MS: "5000" })
    ).toBe(5000);
    expect(
      previewTokenTtlMs({
        TOOL_TOKEN_BUDGET_PREVIEW_TOKEN_TTL_MS: "7000",
        SCHEMA_BUDGET_PREVIEW_TOKEN_TTL_MS: "5000",
      })
    ).toBe(7000);
  });

  it("stage3a-sarif-tool-name-and-rule-ids", () => {
    const report: Report = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      tokenizerId: "o200k_base",
      totals: { estTokens: 0, toolCount: 0, serverCount: 0, findingCount: 1 },
      tools: [],
      servers: [],
      findings: [
        {
          ruleId: "schema-too-large",
          severity: "warn",
          server: "s",
          tool: "t",
          message: "big",
        },
      ],
    };
    const parsed = JSON.parse(formatSarif(report));
    expect(parsed.runs[0].tool.driver.name).toBe(SARIF_TOOL_NAME);
    expect(parsed.runs[0].results[0].ruleId).toBe(sarifRuleId("schema-too-large"));
  });

  it("stage3a-html-cta-uses-new-proposed-filename", () => {
    const html = formatHtml({
      generatedAt: "2026-01-01T00:00:00.000Z",
      tokenizerId: "o200k_base",
      totals: { estTokens: 0, toolCount: 0, serverCount: 0, findingCount: 0 },
      tools: [],
      servers: [],
      findings: [],
      savings: {
        currentEstTokens: 10,
        proposedEstTokens: 5,
        savedEstTokens: 5,
        savedPct: 50,
      },
    });
    expect(html).toContain(defaultProposedFilename());
    expect(html).not.toContain("schema-budget-proposed");
  });
});

describe("stage3a emit proposed hint", () => {
  it("stage3a-emit-without-source-config-prints-proposed-hint", () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "stage3a-no-src-"));
    try {
      const output = execSync(
        `node "${CLI}" emit --tools-json fixtures/tools-tiny.json --out "${outDir}" --no-usage 2>&1`,
        { cwd: repoRoot, encoding: "utf8" }
      );
      const hintLines = output
        .split("\n")
        .filter((line) => /no proposed config written/i.test(line));
      expect(hintLines).toHaveLength(1);
      expect(hintLines[0]).toMatch(/--client/i);
      expect(hintLines[0]).toMatch(/config path/i);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("stage3a-emit-with-source-config-omits-proposed-hint", () => {
    const testDir = mkdtempSync(path.join(tmpdir(), "stage3a-with-src-"));
    const outDir = path.join(testDir, "out");
    const mcpPath = path.join(testDir, "mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { tiny: { command: "node", args: ["x.js"] } } }),
      "utf8"
    );
    try {
      const output = execSync(
        `node "${CLI}" emit --tools-json fixtures/tools-tiny.json "${mcpPath}" --out "${outDir}" --no-usage 2>&1`,
        { cwd: repoRoot, encoding: "utf8" }
      );
      expect(output).not.toMatch(/no proposed config written/i);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe("stage3a cli help strings", () => {
  it("stage3a-cli-help-mentions-tool-token-budget-export", () => {
    const help = execSync(`node "${CLI}" ui --help`, { encoding: "utf8" });
    expect(help).toContain("tool-token-budget-export");
    expect(help).not.toMatch(/default:.*schema-budget-export/);
  });
});
