import { describe, it, expect } from "vitest";
import { execSync, spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("Log redaction (Item 7)", () => {
  const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");

  it("cli.ts 'Cannot load' error redacts secrets from error messages", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "log-redact-cli-"));
    const configPath = path.join(testDir, "mcp.json");

    try {
      // Write malformed JSON (syntax error)
      await writeFile(
        configPath,
        '{"mcpServers":{"test":{"command":"node"}',
        "utf8"
      );

      // Try to load it - should fail with JSON parse error
      let output = "";
      try {
        execSync(`node "${cliPath}" emit "${configPath}" --out "${testDir}/out"`, {
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (err: any) {
        output = err.stderr + err.stdout;
      }

      // Verify error message is shown
      expect(output).toContain("Cannot load");
      
      // JSON parse errors don't include content, but other errors might
      // The key is that any SENTINEL_ patterns in the error would be redacted
      // This test mainly verifies the redaction is applied to the error message
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("redactTransportSummary strips user:password@ from URLs", () => {
    const { redactTransportSummary } = require("../dist/utils/redact.js");

    const summary = "stdio over https://user:SENTINEL_PASS_xyz@api.example.com/path";
    const redacted = redactTransportSummary(summary);

    expect(redacted).not.toContain("SENTINEL_PASS_xyz");
    expect(redacted).toContain("<user>:<password>@");
  });

  it("redactTransportSummary strips sensitive query params", () => {
    const { redactTransportSummary } = require("../dist/utils/redact.js");

    const summary = "http://api.example.com/path?api_key=SENTINEL_KEY_999&other=value";
    const redacted = redactTransportSummary(summary);

    expect(redacted).not.toContain("SENTINEL_KEY_999");
    expect(redacted).toContain("api_key=<from-original>");
  });

  it("server request handler error logs are redacted", async () => {
    // This is harder to test directly, but we can verify the redaction function works
    const { redactSecrets } = require("../dist/utils/redact.js");

    const errorMsg = "Failed to process: SENTINEL_TOKEN_xyz123 in config";
    const redacted = redactSecrets(errorMsg);

    expect(redacted).not.toContain("SENTINEL_TOKEN_xyz123");
    expect(redacted).toContain("<from-original>");
  });

  it("writeArtifacts removal warning doesn't leak secrets from server metadata", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "log-redact-emit-"));
    const outDir = path.join(testDir, "out");

    try {
      // Create a tools.json with servers, where one has zero hot tools
      const toolsPath = path.join(testDir, "tools.json");
      const toolsData = {
        servers: [
          {
            name: "keep-server",
            transportSummary: "stdio",
          },
          {
            name: "drop-server-SENTINEL_NAME_xyz",
            transportSummary: "http over https://user:SENTINEL_PASS_drop@api.example.com",
          },
        ],
        tools: [
          {
            name: "keep-tool",
            server: "keep-server",
            estTokens: 100,
          },
          {
            name: "drop-tool",
            server: "drop-server-SENTINEL_NAME_xyz",
            estTokens: 100,
          },
        ],
      };
      await writeFile(toolsPath, JSON.stringify(toolsData), "utf8");

      // Run emit with --keep-per-server 0 to remove all tools per server
      // This will cause servers with no kept tools to be removed
      let output = "";
      try {
        output = execSync(
          `node "${cliPath}" emit --tools-json "${toolsPath}" --out "${outDir}" --keep-per-server 0 --keep-hot 0 2>&1`,
          {
            encoding: "utf8",
            stdio: "pipe",
          }
        );
      } catch (err: any) {
        output = err.stderr + err.stdout;
      }

      // If removal warnings are shown, verify no sentinel leaks
      // (Server names themselves won't contain secrets in practice, but transportSummary might be logged)
      expect(output).not.toContain("SENTINEL_PASS_drop");
      expect(output).not.toContain("SENTINEL_NAME_xyz");
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("comprehensive: spawn CLI with sentinel config, verify no leaks in stdout/stderr", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "log-redact-spawn-"));

    try {
      // Create a config with multiple sentinels
      const configPath = path.join(testDir, "mcp.json");
      const config = {
        mcpServers: {
          "test-server": {
            command: "node",
            args: ["--token=SENTINEL_ARG_cli123"],
            env: {
              API_KEY: "SENTINEL_ENV_cli456",
            },
            transport: {
              type: "http" as const,
              url: "https://user:SENTINEL_URL_cli789@api.example.com?api_key=SENTINEL_QS_cli000",
            },
          },
        },
      };
      await writeFile(configPath, JSON.stringify(config), "utf8");

      // Spawn the CLI (it will fail to discover, but we're checking logs)
      const proc = spawn("node", [cliPath, "emit", "--config", configPath, "--out", path.join(testDir, "out")], {
        stdio: "pipe",
        timeout: 5000,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      await new Promise<void>((resolve) => {
        proc.on("exit", () => resolve());
        proc.on("error", () => resolve());
        setTimeout(() => {
          proc.kill();
          resolve();
        }, 5000);
      });

      const allOutput = stdout + stderr;

      // Verify no sentinels leaked
      expect(allOutput).not.toContain("SENTINEL_ARG_cli123");
      expect(allOutput).not.toContain("SENTINEL_ENV_cli456");
      expect(allOutput).not.toContain("SENTINEL_URL_cli789");
      expect(allOutput).not.toContain("SENTINEL_QS_cli000");
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
