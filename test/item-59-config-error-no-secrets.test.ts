import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { pollUntil } from "./poll-until.js";
import { formatConfigLoadError } from "../src/config/formatConfigLoadError.js";
import { repoCliPath, startUiCliServer } from "./helpers/uiCliServer.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "s3cr3tK3y99";

function runCli(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("node", [path.join(repoRoot, "dist", "cli.js"), ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("item 59: config load errors never echo file content", () => {
  it("sanitizes JSON parse errors to line/column only", () => {
    const raw = `Expected double-quoted property name in JSON at position 12 (line 2 column 5)`;
    const formatted = formatConfigLoadError(new Error(raw));
    expect(formatted).toMatch(/line 2 column 5/);
    expect(formatted).not.toMatch(/s3cr3t/i);
  });

  it("health, preview, and stderr omit secret from malformed config", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item59-"));
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
    const testHome = await mkdtemp(path.join(os.tmpdir(), "item59-home-"));
    const ui = await startUiCliServer({
      cliPath: repoCliPath(repoRoot),
      args: ["ui", "--no-open", "--watch-interval", "10", mcpPath],
      cwd: testDir,
      env: { HOME: testHome, USERPROFILE: testHome },
    });
    ui.proc.stderr?.on("data", (d) => stderrChunks.push(d.toString()));

    try {
      const bad = `{\n  "apiKey": "${SECRET}",\n  bad\n}\n`;
      await writeFile(mcpPath, bad, "utf8");

      const { token, origin } = ui;

      await pollUntil(async () => {
        const health = await fetch(`${origin}/api/health`, {
          headers: { "X-Auth-Token": token },
        });
        const json = await health.json();
        return Boolean(json.configLoadError);
      }, { label: "configLoadError after malformed save" });

      const healthJson = await (
        await fetch(`${origin}/api/health`, {
          headers: { "X-Auth-Token": token },
        })
      ).json();
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
      const reportJson = await (
        await fetch(`${origin}/api/report`, {
          headers: { "X-Auth-Token": token },
        })
      ).json();

      const stderr = stderrChunks.join("");
      for (const blob of [
        JSON.stringify(healthJson),
        previewText,
        JSON.stringify(reportJson),
        stderr,
        String(healthJson.configLoadError ?? ""),
      ]) {
        expect(blob).not.toContain(SECRET);
      }
    } finally {
      await ui.stop();
      await rm(testDir, { recursive: true, force: true });
      await rm(testHome, { recursive: true, force: true });
    }
  }, 60_000);

  it("CLI analyze and tools-json omit secret from stdout, stderr, and reports", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item59-cli-"));
    const mcpPath = path.join(testDir, "mcp.json");
    const toolsPath = path.join(testDir, "tools.json");
    const badMcp = `{\n  "apiKey": "${SECRET}",\n  bad\n}\n`;
    const badTools = `{\n  "secret": "${SECRET}",\n  "servers": [\n}\n`;
    const { writeFile: wf, rm: rmDir } = await import("node:fs/promises");
    await wf(mcpPath, badMcp, "utf8");
    await wf(toolsPath, badTools, "utf8");

    const reportPath = path.join(testDir, "out-report.json");
    const analyzePos = await runCli(["analyze", mcpPath, "--json"], testDir);
    const analyzeToolsJson = await runCli(
      ["analyze", "--tools-json", toolsPath, "--json"],
      testDir
    );
    const analyzeHtml = await runCli(["analyze", mcpPath, "--html", reportPath], testDir);

    const blobs = [
      analyzePos.stdout,
      analyzePos.stderr,
      analyzeToolsJson.stdout,
      analyzeToolsJson.stderr,
      analyzeHtml.stdout,
      analyzeHtml.stderr,
    ];
    try {
      const { readFile } = await import("node:fs/promises");
      blobs.push(await readFile(reportPath, "utf8"));
    } catch {
      // html may not be written on parse failure
    }
    for (const blob of blobs) {
      expect(blob).not.toContain(SECRET);
    }

    await rmDir(testDir, { recursive: true, force: true });
  });
});
