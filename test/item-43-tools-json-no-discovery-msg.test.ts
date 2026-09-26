import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("item 43: no discovery progress in --tools-json ui mode", () => {
  let cliPath: string;

  beforeAll(() => {
    cliPath = path.join(repoRoot, "dist", "cli.js");
  });

  it("does not print Discovering servers when using --tools-json", async () => {
    const fixture = path.join(repoRoot, "fixtures", "tools-tiny.json");
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const proc = spawn("node", [cliPath, "ui", "--no-open", "--tools-json", fixture], {
        cwd: repoRoot,
      });
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (c) => {
        stdout += c.toString();
      });
      proc.stderr?.on("data", (c) => {
        stderr += c.toString();
      });
      proc.on("error", reject);
      const timer = setTimeout(() => {
        proc.kill();
        resolve({ stdout, stderr });
      }, 8_000);
      proc.stdout?.on("data", (c) => {
        if (c.toString().includes("Tool Token Budget UI running at:")) {
          clearTimeout(timer);
          proc.kill();
          resolve({ stdout, stderr });
        }
      });
    });

    expect(result.stderr).not.toContain("Discovering servers");
    expect(result.stdout).toContain("Tool Token Budget UI running at:");
  });
});
