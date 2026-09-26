import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import { Poller } from "../src/poll/poller.js";
import { analyzeTools } from "../src/pipeline.js";
import { ConfigLoadError } from "../src/config/configLoadError.js";
import { pollUntil } from "./poll-until.js";
import { repoCliPath, startUiCliServer } from "./helpers/uiCliServer.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function startUiServer(mcpPath: string, extraEnv: Record<string, string> = {}) {
  const testHome = await mkdtemp(path.join(os.tmpdir(), "item50-home-"));
  const testDir = path.dirname(path.dirname(mcpPath));
  const ui = await startUiCliServer({
    cliPath: repoCliPath(repoRoot),
    args: ["ui", "--no-open", "--watch-interval", "10", mcpPath],
    cwd: testDir,
    env: {
      HOME: testHome,
      USERPROFILE: testHome,
      ...extraEnv,
    },
  });
  return { ...ui, testHome };
}

describe("item 50: UI survives config load errors", () => {
  it("poll discover catches ConfigLoadError without throwing", async () => {
    let tick = 0;
    const poller = new Poller({
      intervalSec: 10,
      discover: async () => {
        tick++;
        if (tick === 2) {
          throw new ConfigLoadError("Expected , or }");
        }
        return { servers: [], tools: [] };
      },
      analyze: analyzeTools,
      onSnapshot: () => {},
      onError: () => {},
    });
    await poller.start();
    await poller.runNow();
    await poller.runNow();
    poller.stop();
    expect(tick).toBeGreaterThanOrEqual(2);
  });

  it("malformed save keeps server alive then recovers on fix (watch path)", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item50-watch-"));
    const cursorDir = path.join(testDir, ".cursor");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cursorDir, { recursive: true });
    const mcpPath = path.join(cursorDir, "mcp.json");
    const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
    const good = JSON.stringify(
      { mcpServers: { stub: { command: "node", args: [stub] } } },
      null,
      2
    ) + "\n";
    await writeFile(mcpPath, good, "utf8");

    const ui = await startUiServer(mcpPath);
    try {
      const { token, origin } = ui;

      await writeFile(mcpPath, "{ not-json", "utf8");
      await pollUntil(async () => {
        const healthBad = await fetch(`${origin}/api/health`, {
          headers: { "X-Auth-Token": token },
        });
        const healthJson = await healthBad.json();
        return Boolean(healthJson.configLoadError);
      }, { label: "configLoadError after malformed save (watch)" });

      expect(ui.proc.exitCode).toBeNull();

      const previewBad = await fetch(`${origin}/api/apply/preview`, {
        method: "POST",
        headers: {
          "X-Auth-Token": token,
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ policy: {}, clientId: "cursor-project" }),
      });
      expect(previewBad.status).toBe(503);
      expect(await previewBad.text()).toMatch(/cannot be read/i);

      await writeFile(mcpPath, good, "utf8");
      await pollUntil(async () => {
        const healthOk = await fetch(`${origin}/api/health`, {
          headers: { "X-Auth-Token": token },
        });
        return (await healthOk.json()).configLoadError === null;
      }, { label: "config recovered after fix (watch)" });

      const previewOk = await fetch(`${origin}/api/apply/preview`, {
        method: "POST",
        headers: {
          "X-Auth-Token": token,
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ policy: {}, clientId: "cursor-project" }),
      });
      expect(previewOk.status).toBe(200);
    } finally {
      await ui.stop();
      await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      await rm(ui.testHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it("delete then recreate recovers (poll path without fs.watch)", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item50-poll-"));
    const cursorDir = path.join(testDir, ".cursor");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cursorDir, { recursive: true });
    const mcpPath = path.join(cursorDir, "mcp.json");
    const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
    const good = JSON.stringify(
      { mcpServers: { stub: { command: "node", args: [stub] } } },
      null,
      2
    ) + "\n";
    await writeFile(mcpPath, good, "utf8");

    const ui = await startUiServer(mcpPath, {
      SCHEMA_BUDGET_UI_NO_WATCH: "1",
    });
    try {
      const { token, origin } = ui;

      await unlink(mcpPath);
      await pollUntil(async () => {
        const healthDel = await fetch(`${origin}/api/health`, {
          headers: { "X-Auth-Token": token },
        });
        return Boolean((await healthDel.json()).configLoadError);
      }, { timeoutMs: 20_000, label: "configLoadError after delete (poll)" });

      expect(ui.proc.exitCode).toBeNull();

      await writeFile(mcpPath, good, "utf8");
      await pollUntil(async () => {
        const healthOk = await fetch(`${origin}/api/health`, {
          headers: { "X-Auth-Token": token },
        });
        return (await healthOk.json()).configLoadError === null;
      }, { timeoutMs: 20_000, label: "config recovered after recreate (poll)" });
    } finally {
      await ui.stop();
      await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      await rm(ui.testHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);
});
