import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import { pollUntil } from "./poll-until.js";
import { repoCliPath, startUiCliServer } from "./helpers/uiCliServer.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("item 62: keep client list when config deleted", () => {
  it("returns cached clients and 503 preview instead of 404", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item62-"));
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

    const testHome = await mkdtemp(path.join(os.tmpdir(), "item62-home-"));
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

    try {
      const { token, origin } = ui;

      await fetch(`${origin}/api/clients`, {
        headers: { "X-Auth-Token": token },
      });

      await unlink(mcpPath);
      await pollUntil(async () => {
        try {
          const health = await fetch(`${origin}/api/health`, {
            headers: { "X-Auth-Token": token },
          });
          const json = await health.json();
          return json.status === "degraded" || Boolean(json.configLoadError);
        } catch {
          return false;
        }
      }, { timeoutMs: 20_000, label: "configLoadError after delete" });

      const clientsRes = await fetch(`${origin}/api/clients`, {
        headers: { "X-Auth-Token": token },
      });
      const clientsJson = await clientsRes.json();
      expect(clientsJson.clients.some((c: { id: string }) => c.id === "cursor-project")).toBe(
        true
      );

      const preview = await fetch(`${origin}/api/apply/preview`, {
        method: "POST",
        headers: {
          "X-Auth-Token": token,
          "Content-Type": "application/json",
          Origin: origin,
        },
        body: JSON.stringify({ policy: {}, clientId: "cursor-project" }),
      });
      expect(preview.status).toBe(503);
      expect(await preview.text()).toMatch(/cannot be read/i);
    } finally {
      await ui.stop();
      await rm(testDir, { recursive: true, force: true });
      await rm(testHome, { recursive: true, force: true });
    }
  }, 90_000);
});
