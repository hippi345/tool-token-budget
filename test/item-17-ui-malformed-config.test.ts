import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function runUi(args: string[]): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn("node", args, {
      cwd: repoRoot,
      env: { ...process.env, NO_OPEN_BROWSER: "1" },
    });
    let output = "";
    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.on("close", (code) => resolve({ exitCode: code, output }));
  });
}

describe("item 17: ui validates config before starting server", () => {
  let cliPath: string;
  const testPort = 47666;

  beforeAll(() => {
    cliPath = path.join(repoRoot, "dist", "cli.js");
  });

  afterEach(async () => {
    expect(await isPortListening(testPort)).toBe(false);
  });

  it("exits non-zero for malformed mcp.json without printing running URL or binding port", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "item17-bad-config-"));
    const badPath = path.join(dir, "mcp.json");
    await writeFile(badPath, "{ not valid json\n", "utf8");

    const { exitCode, output } = await runUi([
      cliPath,
      "ui",
      "--no-open",
      `--port`,
      String(testPort),
      badPath,
    ]);

    await rm(dir, { recursive: true, force: true });

    expect(exitCode).not.toBe(0);
    expect(output).not.toMatch(/running at/i);
    expect(output).toContain("Cannot load");
    expect(await isPortListening(testPort)).toBe(false);
  });

  it("exits non-zero for malformed --tools-json without printing running URL or binding port", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "item17-bad-tools-"));
    const badTools = path.join(dir, "tools.json");
    await writeFile(badTools, "{ broken", "utf8");

    const { exitCode, output } = await runUi([
      cliPath,
      "ui",
      "--no-open",
      `--port`,
      String(testPort),
      "--tools-json",
      badTools,
    ]);

    await rm(dir, { recursive: true, force: true });

    expect(exitCode).not.toBe(0);
    expect(output).not.toMatch(/running at/i);
    expect(output).toMatch(/Cannot load|Unrecognized/i);
    expect(await isPortListening(testPort)).toBe(false);
  });
});
