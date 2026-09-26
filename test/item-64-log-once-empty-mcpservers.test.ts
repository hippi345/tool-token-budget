import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { pollUntil } from "./poll-until.js";
import { repoCliPath, startUiCliServer } from "./helpers/uiCliServer.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LOG_LINE = /Cannot load config \(will retry\):/g;

describe("item 64: empty mcpServers array logs once per error", () => {
  it("emits a single clean config-load line across multiple polls", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item64-"));
    const cursorDir = path.join(testDir, ".cursor");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cursorDir, { recursive: true });
    const mcpPath = path.join(cursorDir, "mcp.json");
    const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
    const good =
      JSON.stringify(
        { mcpServers: { stub: { command: "node", args: [stub] } } },
        null,
        2
      ) + "\n";
    await writeFile(mcpPath, good, "utf8");

    const stderrChunks: string[] = [];
    const testHome = await mkdtemp(path.join(os.tmpdir(), "item64-home-"));
    const ui = await startUiCliServer({
      cliPath: repoCliPath(repoRoot),
      args: ["ui", "--no-open", "--watch-interval", "10", mcpPath],
      cwd: testDir,
      env: {
        HOME: testHome,
        USERPROFILE: testHome,
        SCHEMA_BUDGET_UI_NO_WATCH: "1",
      },
    });
    ui.proc.stderr?.on("data", (d) => stderrChunks.push(d.toString()));

    try {
      await writeFile(mcpPath, '{"mcpServers":[]}\n', "utf8");
      await pollUntil(
        async () => stderrChunks.join("").includes("Cannot load config (will retry):"),
        { timeoutMs: 25_000, label: "first config load error logged" }
      );

      const firstLogAt = Date.now();
      await pollUntil(
        async () => {
          const stderr = stderrChunks.join("");
          const matches = stderr.match(LOG_LINE) ?? [];
          if (matches.length > 1) {
            throw new Error("duplicate config load log line");
          }
          return Date.now() - firstLogAt >= 11_000;
        },
        { timeoutMs: 25_000, intervalMs: 400, label: "no duplicate logs across poll interval" }
      );

      const stderr = stderrChunks.join("");
      const matches = stderr.match(LOG_LINE) ?? [];
      expect(matches.length).toBe(1);
      expect(stderr).not.toMatch(/^\s+at /m);
    } finally {
      await ui.stop();
      await rm(testDir, { recursive: true, force: true });
      await rm(testHome, { recursive: true, force: true });
    }
  }, 90_000);

  it("watch path logs each distinct config error once (not only the first forever)", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item64-watch-"));
    const cursorDir = path.join(testDir, ".cursor");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cursorDir, { recursive: true });
    const mcpPath = path.join(cursorDir, "mcp.json");
    const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
    const good =
      JSON.stringify(
        { mcpServers: { stub: { command: "node", args: [stub] } } },
        null,
        2
      ) + "\n";
    await writeFile(mcpPath, good, "utf8");

    const stderrChunks: string[] = [];
    const testHome = await mkdtemp(path.join(os.tmpdir(), "item64-watch-home-"));
    const ui = await startUiCliServer({
      cliPath: repoCliPath(repoRoot),
      args: ["ui", "--no-open", "--watch-interval", "10", mcpPath],
      cwd: testDir,
      env: {
        HOME: testHome,
        USERPROFILE: testHome,
      },
    });
    ui.proc.stderr?.on("data", (d) => stderrChunks.push(d.toString()));

    try {
      await writeFile(mcpPath, '{"mcpServers":[]}\n', "utf8");
      await pollUntil(
        async () => stderrChunks.join("").includes("Cannot load config (will retry):"),
        { timeoutMs: 45_000, label: "first watch error" }
      );
      await writeFile(mcpPath, "null\n", "utf8");
      await pollUntil(
        async () => stderrChunks.join("").includes("Unrecognized config shape"),
        { timeoutMs: 45_000, label: "second distinct watch error" }
      );
      const stderr = stderrChunks.join("");
      expect(stderr).toMatch(/Cannot load config \(will retry\):/);
      expect(stderr).toContain("Unrecognized config shape");
    } finally {
      await ui.stop();
      await rm(testDir, { recursive: true, force: true });
      await rm(testHome, { recursive: true, force: true });
    }
  }, 120_000);
});
