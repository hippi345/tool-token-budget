import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import { renameWithRetry } from "../src/utils/renameWithRetry.js";
import { spawn } from "node:child_process";
import { formatConfigLoadError } from "../src/config/formatConfigLoadError.js";
import { repoCliPath, startUiCliServer } from "./helpers/uiCliServer.js";
import { applyConfig } from "../src/apply/applyConfig.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SENTINEL = "QZXW59hArgUnqSecret";

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, content, "utf8");
  await renameWithRetry(tmp, filePath);
}

function assertNoSentinel(blob: string): void {
  expect(blob).not.toContain(SENTINEL);
  expect(blob).not.toContain("QZXW59");
}

function extractConfigLoadErrorsFromSse(sseText: string): string[] {
  const errors: string[] = [];
  for (const block of sseText.split("\n\n")) {
    if (!block.startsWith("data: ")) {
      continue;
    }
    try {
      const data = JSON.parse(block.slice(6)) as {
        serverMetadata?: { configLoadError?: string | null };
      };
      const err = data.serverMetadata?.configLoadError;
      if (err) {
        errors.push(String(err));
      }
    } catch {
      // ignore partial frames
    }
  }
  return errors;
}

async function readSseUntilConfigLoadError(
  origin: string,
  token: string,
  timeoutMs = 45_000
): Promise<string> {
  const http = await import("node:http");
  const parsed = new URL(origin);
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const deadline = setTimeout(() => {
      req.destroy();
      reject(new Error(`Timed out waiting for SSE configLoadError (${timeoutMs}ms)`));
    }, timeoutMs);

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: "/api/events",
        method: "GET",
        headers: {
          "X-Auth-Token": token,
          Accept: "text/event-stream",
        },
      },
      (res) => {
        res.on("data", (chunk) => {
          const text = chunk.toString();
          chunks.push(text);
          const joined = chunks.join("");
          if (extractConfigLoadErrorsFromSse(joined).length > 0) {
            clearTimeout(deadline);
            req.destroy();
            resolve(joined);
          }
        });
      }
    );

    req.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.end();
  });
}

function runCli(args: string[], cwd: string, env?: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const proc = spawn("node", [path.join(repoRoot, "dist", "cli.js"), ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const BAD_CONFIGS: Array<{ label: string; lf: string; crlf: string }> = [
  {
    label: "unquoted value replacing quoted API_KEY",
    lf: `{\n  "mcpServers": {\n    "s": {\n      "command": "node",\n      "args": ["x.js"],\n      "env": { "API_KEY": ${SENTINEL} }\n    }\n  }\n}\n`,
    crlf: `{\r\n  "mcpServers": {\r\n    "s": {\r\n      "command": "node",\r\n      "args": ["x.js"],\r\n      "env": { "API_KEY": ${SENTINEL} }\r\n    }\r\n  }\r\n}\r\n`,
  },
  {
    label: "unquoted secret inside args array",
    lf: `{\n  "mcpServers": {\n    "s": {\n      "command": "node",\n      "args": [${SENTINEL}]\n    }\n  }\n}\n`,
    crlf: `{\r\n  "mcpServers": {\r\n    "s": {\r\n      "command": "node",\r\n      "args": [${SENTINEL}]\r\n    }\r\n  }\r\n}\r\n`,
  },
];

describe("config parse errors never leak source (shared sanitizer)", () => {
  for (const variant of BAD_CONFIGS) {
    for (const eol of ["lf", "crlf"] as const) {
      it(`formatConfigLoadError: ${variant.label} (${eol})`, () => {
        const body = eol === "lf" ? variant.lf : variant.crlf;
        let err: Error;
        try {
          JSON.parse(body);
          throw new Error("expected parse failure");
        } catch (e) {
          err = e as Error;
        }
        const formatted = formatConfigLoadError(err);
        assertNoSentinel(formatted);
        expect(formatted).toMatch(/JSON syntax error/);
        expect(formatted).not.toBe("Un");
      });
    }
  }

  for (const variant of BAD_CONFIGS) {
    it(`UI surfaces: ${variant.label} (health, report, export, immediate preview)`, async () => {
      const testDir = await mkdtemp(path.join(os.tmpdir(), "cfg-surf-"));
      const cursorDir = path.join(testDir, ".cursor");
      await mkdir(cursorDir, { recursive: true });
      const mcpPath = path.join(cursorDir, "mcp.json");
      const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
      const good =
        JSON.stringify({ mcpServers: { stub: { command: "node", args: [stub] } } }, null, 2) + "\n";
      await writeFile(mcpPath, good, "utf8");

      const testHome = await mkdtemp(path.join(os.tmpdir(), "cfg-surf-home-"));
      const ui = await startUiCliServer({
        cliPath: repoCliPath(repoRoot),
        args: ["ui", "--no-open", "--watch-interval", "10", mcpPath],
        cwd: testDir,
        env: { HOME: testHome, USERPROFILE: testHome, SCHEMA_BUDGET_UI_NO_WATCH: "1" },
      });

      try {
        await writeFile(mcpPath, variant.lf, "utf8");
        const { token, origin } = ui;

        const healthJson = await (
          await fetch(`${origin}/api/health`, { headers: { "X-Auth-Token": token } })
        ).json();
        const reportJson = await (
          await fetch(`${origin}/api/report`, { headers: { "X-Auth-Token": token } })
        ).text();
        const previewText = await (
          await fetch(`${origin}/api/apply/preview`, {
            method: "POST",
            headers: {
              "X-Auth-Token": token,
              "Content-Type": "application/json",
              Origin: origin,
            },
            body: JSON.stringify({ policy: {}, clientId: "cursor-project" }),
          })
        ).text();
        const exportRes = await fetch(`${origin}/api/export`, {
          method: "POST",
          headers: {
            "X-Auth-Token": token,
            "Content-Type": "application/json",
            Origin: origin,
          },
          body: JSON.stringify({ policy: {}, clientId: "cursor-project" }),
        });
        const exportText = await exportRes.text();

        for (const blob of [
          JSON.stringify(healthJson),
          reportJson,
          previewText,
          exportText,
          String(healthJson.configLoadError ?? ""),
        ]) {
          assertNoSentinel(blob);
        }
        expect(exportRes.status).toBe(503);
        expect(previewText).toMatch(/cannot be read/i);
      } finally {
        await ui.stop();
        await rm(testDir, { recursive: true, force: true });
        await rm(testHome, { recursive: true, force: true });
      }
    }, 90_000);
  }

  for (const eol of ["lf", "crlf"] as const) {
    it(`SSE /api/events omits sentinel and includes sanitized config error (${eol})`, async () => {
      const testDir = await mkdtemp(path.join(os.tmpdir(), "cfg-sse-"));
      const cursorDir = path.join(testDir, ".cursor");
      await mkdir(cursorDir, { recursive: true });
      const mcpPath = path.join(cursorDir, "mcp.json");
      const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
      const good =
        JSON.stringify({ mcpServers: { stub: { command: "node", args: [stub] } } }, null, 2) + "\n";
      await writeFile(mcpPath, good, "utf8");

      const testHome = await mkdtemp(path.join(os.tmpdir(), "cfg-sse-home-"));
      const ui = await startUiCliServer({
        cliPath: repoCliPath(repoRoot),
        args: ["ui", "--no-open", "--watch-interval", "10", mcpPath],
        cwd: testDir,
        env: { HOME: testHome, USERPROFILE: testHome },
      });

      try {
        const { token, origin } = ui;
        const badBody = eol === "lf" ? BAD_CONFIGS[0].lf : BAD_CONFIGS[0].crlf;

        const ssePromise = readSseUntilConfigLoadError(origin, token);
        await writeFileAtomic(mcpPath, badBody);
        const sseText = await ssePromise;

        assertNoSentinel(sseText);
        const loadErrors = extractConfigLoadErrorsFromSse(sseText);
        expect(loadErrors.length).toBeGreaterThan(0);
        for (const msg of loadErrors) {
          assertNoSentinel(msg);
          expect(msg).toMatch(/JSON syntax error/i);
        }
      } finally {
        await ui.stop();
        await rm(testDir, { recursive: true, force: true });
        await rm(testHome, { recursive: true, force: true });
      }
    }, 90_000);
  }

  it("stage1-r4-item2: SSE config error stable under atomic rewrite stress (crlf)", async () => {
    const iterations = 3;
    const stressDirs: string[] = [];
    const stressHomes: string[] = [];
    try {
      for (let i = 0; i < iterations; i++) {
        const testDir = await mkdtemp(path.join(os.tmpdir(), "cfg-sse-stress-"));
        stressDirs.push(testDir);
        const cursorDir = path.join(testDir, ".cursor");
        await mkdir(cursorDir, { recursive: true });
        const mcpPath = path.join(cursorDir, "mcp.json");
        const stub = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
        const good =
          JSON.stringify({ mcpServers: { stub: { command: "node", args: [stub] } } }, null, 2) +
          "\n";
        await writeFileAtomic(mcpPath, good);

        const testHome = await mkdtemp(path.join(os.tmpdir(), "cfg-sse-stress-home-"));
        stressHomes.push(testHome);
        const ui = await startUiCliServer({
          cliPath: repoCliPath(repoRoot),
          args: ["ui", "--no-open", "--watch-interval", "10", mcpPath],
          cwd: testDir,
          env: { HOME: testHome, USERPROFILE: testHome },
        });

        try {
          const { token, origin } = ui;
          const badBody = BAD_CONFIGS[0].crlf;
          const ssePromise = readSseUntilConfigLoadError(origin, token);
          await writeFileAtomic(mcpPath, badBody);
          const sseText = await ssePromise;
          const loadErrors = extractConfigLoadErrorsFromSse(sseText);
          expect(loadErrors.length).toBeGreaterThan(0);
          for (const msg of loadErrors) {
            expect(msg).toMatch(/JSON syntax error/i);
            expect(msg).not.toMatch(/empty or truncated/i);
          }
        } finally {
          await ui.stop();
        }
      }
    } finally {
      for (const d of stressDirs) {
        await rm(d, { recursive: true, force: true }).catch(() => {});
      }
      for (const h of stressHomes) {
        await rm(h, { recursive: true, force: true }).catch(() => {});
      }
    }
  }, 45_000);

  it("CLI ui startup with bad config file redacts parse errors", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "cfg-ui-cli-"));
    const badPath = path.join(testDir, "mcp.json");
    await writeFile(badPath, BAD_CONFIGS[0].lf, "utf8");
    const result = await runCli(["ui", "--no-open", badPath], testDir);
    const combined = result.stdout + result.stderr;
    assertNoSentinel(combined);
    expect(combined).toMatch(/Cannot load/);
    await rm(testDir, { recursive: true, force: true });
  });

  it("CLI apply --dry-run redacts original config read errors", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "cfg-apply-"));
    const mcpPath = path.join(testDir, "mcp.json");
    const proposedPath = path.join(testDir, "proposed.json");
    await writeFile(mcpPath, BAD_CONFIGS[0].lf, "utf8");
    await writeFile(proposedPath, '{"mcpServers":{}}\n', "utf8");
    const result = await applyConfig({
      mcpConfigPath: mcpPath,
      proposedPath,
      dryRun: true,
      backup: false,
      yes: false,
    });
    expect(result.success).toBe(false);
    assertNoSentinel(result.error ?? "");
    expect(result.error).toMatch(/Failed to read original config:/);
    await rm(testDir, { recursive: true, force: true });
  });

  it("CLI lint-server --tools-json redacts parse errors (no stack trace)", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "cfg-lint-"));
    const toolsPath = path.join(testDir, "tools.json");
    await writeFile(
      toolsPath,
      `{\n  "servers": [],\n  "note": ${SENTINEL}\n}\n`,
      "utf8"
    );
    const result = await runCli(["lint-server", "--tools-json", toolsPath], testDir);
    const combined = result.stdout + result.stderr;
    assertNoSentinel(combined);
    expect(combined).not.toMatch(/^\s+at /m);
    await rm(testDir, { recursive: true, force: true });
  });
});
