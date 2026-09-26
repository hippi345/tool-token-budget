import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import { pollUntil } from "./poll-until.js";
import { repoCliPath, startUiCliServer } from "./helpers/uiCliServer.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BAD_SHAPES: Array<{ label: string; body: string }> = [
  { label: "empty object", body: "{}\n" },
  { label: "null", body: "null\n" },
  { label: "array", body: "[]\n" },
  { label: "extra key", body: '{"x":1}\n' },
  { label: "mcpServers null", body: '{"mcpServers":null}\n' },
];

async function startUiServer(mcpPath: string, extraEnv: Record<string, string> = {}) {
  const testHome = await mkdtemp(path.join(os.tmpdir(), "item55-home-"));
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

describe("item 55: unrecognized JSON shapes do not kill UI server", () => {
  for (const mode of ["watch", "poll"] as const) {
    describe(`${mode} mode (shared server)`, () => {
      let testDir: string;
      let mcpPath: string;
      let good: string;
      let ui: Awaited<ReturnType<typeof startUiServer>>;

      beforeAll(async () => {
        testDir = await mkdtemp(path.join(os.tmpdir(), `item55-${mode}-`));
        const cursorDir = path.join(testDir, ".cursor");
        await mkdir(cursorDir, { recursive: true });
        mcpPath = path.join(cursorDir, "mcp.json");
        const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
        good =
          JSON.stringify(
            { mcpServers: { stub: { command: "node", args: [stub] } } },
            null,
            2
          ) + "\n";
        await writeFile(mcpPath, good, "utf8");

        const extraEnv = mode === "poll" ? { SCHEMA_BUDGET_UI_NO_WATCH: "1" } : {};
        ui = await startUiServer(mcpPath, extraEnv);
        await pollUntil(async () => {
          const health = await fetch(`${ui.origin}/api/health`, {
            headers: { "X-Auth-Token": ui.token },
          });
          return health.ok;
        }, { label: `item55 ${mode} server ready` });
      }, 60_000);

      afterAll(async () => {
        if (ui) {
          await ui.stop();
        }
        if (testDir) {
          await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
        if (ui?.testHome) {
          await rm(ui.testHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
      }, 30_000);

      for (const shape of BAD_SHAPES) {
        it(`${mode}: survives ${shape.label} then recovers`, async () => {
          const { token, origin } = ui;

          await writeFile(mcpPath, shape.body, "utf8");
          await pollUntil(async () => {
            const health = await fetch(`${origin}/api/health`, {
              headers: { "X-Auth-Token": token },
            });
            const json = await health.json();
            return json.status === "degraded" && Boolean(json.configLoadError);
          }, { label: `degraded health for ${shape.label} (${mode})` });

          expect(ui.proc.exitCode).toBeNull();

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

          await writeFile(mcpPath, good, "utf8");
          await pollUntil(async () => {
            const health = await fetch(`${origin}/api/health`, {
              headers: { "X-Auth-Token": token },
            });
            const json = await health.json();
            return json.configLoadError === null;
          }, { timeoutMs: mode === "poll" ? 20_000 : 15_000, label: `recovery ${shape.label} (${mode})` });
        }, 90_000);
      }
    });
  }
});
