import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { ffmpegOnPath } from "./helpers/toolingOnPath.ts";
import {
  countEditorErrorBanners,
  exportButtonTitleWhenConfigError,
  isExportBlockedByConfigLoadError,
  shouldShowExportConfigHint,
  EXPORT_CONFIG_ERROR_HINT,
  EXPORT_CONFIG_ERROR_HINT_ID,
} from "../gui/src/configHealthUi.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(repoRoot, "test");

async function listTestSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "e2e" || entry.name === "setup") {
        continue;
      }
      files.push(...(await listTestSourceFiles(full)));
      continue;
    }
    if (/\.test\.(t|j)sx?$/.test(entry.name) || entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function extractGifFrame(gifPath: string, frameIndex: number, outPath: string): void {
  const vf = `select=eq(n\\,${frameIndex})`;
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-i", gifPath, "-vf", vf, "-frames:v", "1", "-update", "1", outPath],
    { stdio: "pipe" }
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.toString() || result.stdout?.toString() || "ffmpeg frame extract failed"
    );
  }
}

describe("PR #20 round 3", () => {
  it("pr20-r3-item01 test sources do not hardcode /opt/cursor paths", async () => {
    const files = await listTestSourceFiles(testDir);
    const offenders: string[] = [];
    const selfPath = fileURLToPath(import.meta.url);
    for (const file of files) {
      if (path.resolve(file) === path.resolve(selfPath)) {
        continue;
      }
      const text = await readFile(file, "utf8");
      if (text.includes("/opt/cursor")) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it.skipIf(!ffmpegOnPath)(
    "pr20-r3-item02 demo GIF frames extract when ffmpeg is on PATH",
    async () => {
      const gif = path.join(repoRoot, "demos", "tool-token-budget-demo.gif");
      expect(statSync(gif).size).toBeGreaterThan(10_000);

      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "tool-token-budget-demo-frames-"));
      const firstFrame = path.join(tmpDir, "first.png");
      const midFrame = path.join(tmpDir, "mid.png");
      try {
        extractGifFrame(gif, 45, firstFrame);
        extractGifFrame(gif, 220, midFrame);
        expect(statSync(firstFrame).size).toBeGreaterThan(1000);
        expect(statSync(midFrame).size).toBeGreaterThan(1000);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    }
  );

  it("pr20-r3-item03 Export disabled with hint when config cannot load", async () => {
    const configMsg = "JSON syntax error at line 2 column 3";
    expect(isExportBlockedByConfigLoadError(configMsg)).toBe(true);
    expect(shouldShowExportConfigHint(configMsg)).toBe(true);
    expect(EXPORT_CONFIG_ERROR_HINT).toBe(
      "Fix the config error shown in Apply to export"
    );
    expect(EXPORT_CONFIG_ERROR_HINT).not.toMatch(/above/i);
    expect(exportButtonTitleWhenConfigError(configMsg)).toBe(EXPORT_CONFIG_ERROR_HINT);
    expect(
      countEditorErrorBanners({
        configLoadError: configMsg,
        exportError: "Cannot export while config is broken",
        applyPreviewError: "Config file cannot be read: stale",
      })
    ).toBe(1);

    expect(isExportBlockedByConfigLoadError(null)).toBe(false);
    expect(shouldShowExportConfigHint(null)).toBe(false);
    expect(exportButtonTitleWhenConfigError(null)).toBeUndefined();
    expect(
      countEditorErrorBanners({
        configLoadError: null,
        exportError: "disk full",
        applyPreviewError: null,
      })
    ).toBe(1);

    const editor = await readFile(path.join(repoRoot, "gui", "src", "Editor.tsx"), "utf8");
    expect(editor).toContain("isExportBlockedByConfigLoadError(serverMetadata.configLoadError)");
    expect(editor).toContain(`id={EXPORT_CONFIG_ERROR_HINT_ID}`);
    expect(editor).toContain("aria-describedby");
    expect(editor).toContain("{EXPORT_CONFIG_ERROR_HINT}");
    const exportSection = editor.slice(
      editor.indexOf('className="export-section"'),
      editor.indexOf('className="apply-section"')
    );
    expect(exportSection).not.toContain("Config file cannot be read");
  });
});
