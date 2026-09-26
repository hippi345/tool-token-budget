import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../dist/cli.js");

function runLintServer(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} lint-server ${args}`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      exitCode: err.status || 1,
    };
  }
}

describe("lint-server command", () => {
  it("fails on bloated fixture with warnings", () => {
    const result = runLintServer("--tools-json fixtures/tools-bloated.json");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("tool-token-budget lint-server");
    expect(result.stdout).toContain("description-too-long");
    expect(result.stdout).toContain("schema-too-large");
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/FAILED:.*findings/);
  });

  it("passes on clean fixture", () => {
    const result = runLintServer("--tools-json fixtures/tools-tiny.json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("OK: No lint findings - schema is clean");
  });

  it("respects --fail-on error (passes with only warnings)", () => {
    const result = runLintServer("--tools-json fixtures/tools-bloated.json --fail-on error");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("All findings below --fail-on error");
  });

  it("respects --fail-on info (fails with info findings)", () => {
    const result = runLintServer("--tools-json fixtures/tools-enums.json --fail-on info");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("huge-enum");
  });

  it("requires --tools-json argument", () => {
    const result = runLintServer("");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--tools-json <file> is required");
  });

  it("shows correct exit codes for different severities", () => {
    // Default is warn, should fail on bloated
    const warnResult = runLintServer("--tools-json fixtures/tools-bloated.json");
    expect(warnResult.exitCode).toBe(1);

    // Info level should also fail (has deep-schema info)
    const infoResult = runLintServer("--tools-json fixtures/tools-bloated.json --fail-on info");
    expect(infoResult.exitCode).toBe(1);
  });
});
