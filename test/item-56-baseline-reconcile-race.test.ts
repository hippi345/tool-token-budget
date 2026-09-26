import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { pollUntil } from "./poll-until.js";
import { repoCliPath, startUiCliServer } from "./helpers/uiCliServer.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("item 56: baseline hash matches discovery content", () => {
  let hook: ((content: string, configPath: string) => Promise<void>) | undefined;

  beforeEach(() => {
    (
      globalThis as {
        __schemaBudgetTestAfterConfigRead?: (
          content: string,
          configPath: string
        ) => Promise<void>;
      }
    ).__schemaBudgetTestAfterConfigRead = hook;
  });

  afterEach(() => {
    delete (
      globalThis as { __schemaBudgetTestAfterConfigRead?: unknown }
    ).__schemaBudgetTestAfterConfigRead;
  });

  it("preview converges to 200 after file changes between read and discovery", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item56-"));
    const cursorDir = path.join(testDir, ".cursor");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cursorDir, { recursive: true });
    const mcpPath = path.join(cursorDir, "mcp.json");
    const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
    const base = {
      small: { command: "node", args: [stub] },
      big: { command: "node", args: [stub] },
    };
    const original =
      JSON.stringify({ mcpServers: base }, null, 2) + "\n";
    const tamperedServers = {
      ...base,
      "late-added": { command: "node", args: [stub] },
    };
    const tampered =
      JSON.stringify({ mcpServers: tamperedServers }, null, 2) + "\n";

    await writeFile(mcpPath, original, "utf8");

    hook = async (content, configPath) => {
      if (configPath === mcpPath && content === original) {
        await writeFile(mcpPath, tampered, "utf8");
      }
    };

    const testHome = await mkdtemp(path.join(os.tmpdir(), "item56-home-"));
    const ui = await startUiCliServer({
      cliPath: repoCliPath(repoRoot),
      args: ["ui", "--no-open", "--watch-interval", "10", mcpPath],
      cwd: testDir,
      env: { HOME: testHome, USERPROFILE: testHome },
    });

    try {
      const { token, origin } = ui;

      await writeFile(mcpPath, tampered, "utf8");
      await pollUntil(async () => {
        const res = await fetch(`${origin}/api/apply/preview`, {
          method: "POST",
          headers: {
            "X-Auth-Token": token,
            "Content-Type": "application/json",
            Origin: origin,
          },
          body: JSON.stringify({ policy: {}, clientId: "cursor-project" }),
        });
        return res.status === 409;
      }, { label: "409 while baseline stale" });

      await writeFile(mcpPath, original, "utf8");
      await pollUntil(async () => {
        const res = await fetch(`${origin}/api/apply/preview`, {
          method: "POST",
          headers: {
            "X-Auth-Token": token,
            "Content-Type": "application/json",
            Origin: origin,
          },
          body: JSON.stringify({ policy: {}, clientId: "cursor-project" }),
        });
        return res.status === 200;
      }, { timeoutMs: 30_000, label: "preview 200 after identical restore" });
    } finally {
      await ui.stop();
      await rm(testDir, { recursive: true, force: true });
      await rm(testHome, { recursive: true, force: true });
    }
  }, 120_000);
});
