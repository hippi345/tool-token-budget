import { describe, it, expect, beforeAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type StreamEvent = { stream: "stdout" | "stderr"; text: string; at: number };

async function rmRetry(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

describe("item 33: ui discovery progress on stderr", () => {
  let cliPath: string;

  beforeAll(() => {
    cliPath = path.join(repoRoot, "dist", "cli.js");
  });

  it("prints Discovering servers before the running URL", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "item33-"));
    const mcpPath = path.join(testDir, "mcp.json");
    const stubPath = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
    await writeFile(
      mcpPath,
      JSON.stringify(
        { mcpServers: { stub: { command: "node", args: [stubPath] } } },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const events: StreamEvent[] = [];
    const result = await new Promise<{ events: StreamEvent[] }>((resolve, reject) => {
      const proc: ChildProcess = spawn("node", [cliPath, "ui", "--no-open", mcpPath], {
        cwd: testDir,
        env: { ...process.env, HOME: testDir, USERPROFILE: testDir },
      });
      proc.stdout?.on("data", (c) => {
        events.push({ stream: "stdout", text: c.toString(), at: Date.now() });
      });
      proc.stderr?.on("data", (c) => {
        events.push({ stream: "stderr", text: c.toString(), at: Date.now() });
      });
      proc.on("error", reject);
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("timed out waiting for UI URL"));
      }, 20_000);
      proc.stdout?.on("data", (c) => {
        if (c.toString().includes("Tool Token Budget UI running at:")) {
          clearTimeout(timer);
          proc.kill();
        }
      });
      proc.on("exit", () => resolve({ events }));
    });

    const stderrText = result.events.filter((e) => e.stream === "stderr").map((e) => e.text).join("");
    const stdoutText = result.events.filter((e) => e.stream === "stdout").map((e) => e.text).join("");
    expect(stderrText).toContain("Discovering servers...");

    const discoverEvent = result.events.find(
      (e) => e.stream === "stderr" && e.text.includes("Discovering servers")
    );
    const urlEvent = result.events.find(
      (e) => e.stream === "stdout" && e.text.includes("Tool Token Budget UI running at:")
    );
    expect(discoverEvent).toBeDefined();
    expect(urlEvent).toBeDefined();
    expect(discoverEvent!.at).toBeLessThanOrEqual(urlEvent!.at);
    expect(stdoutText).toContain("Tool Token Budget UI running at:");

    await rmRetry(testDir);
  });
});
