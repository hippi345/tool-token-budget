import { describe, it, expect } from "vitest";
import { classifyStdioConnectFailure } from "../src/discover/spawnError.js";
import { discoverFromMcpConfig } from "../src/discover/fromMcpConfig.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("item 54: spawn_failed vs handshake_failed", () => {
  it("classifies launch failures as spawn_failed", () => {
    expect(classifyStdioConnectFailure("spawn ENOENT")).toBe("spawn_failed");
    expect(
      classifyStdioConnectFailure("connect failed", {
        stderr: "EACCES: permission denied",
        exitCode: 1,
      })
    ).toBe("spawn_failed");
    expect(classifyStdioConnectFailure("failed", { exitCode: 127 })).toBe("spawn_failed");
    expect(classifyStdioConnectFailure("failed", { exitCode: 9009 })).toBe("spawn_failed");
    expect(
      classifyStdioConnectFailure("failed", {
        stderr: "'foo' is not recognized as an internal or external command",
        exitCode: 9009,
      })
    ).toBe("spawn_failed");
    expect(
      classifyStdioConnectFailure("failed", {
        stderr: "npm ERR! code E404",
        sawStdout: false,
      })
    ).toBe("spawn_failed");
    expect(
      classifyStdioConnectFailure("failed", {
        stderr: "npm error code E404",
        sawStdout: false,
      })
    ).toBe("spawn_failed");
    expect(
      classifyStdioConnectFailure("failed", {
        stderr: "npm error 404 Not Found",
        sawStdout: false,
      })
    ).toBe("spawn_failed");
    expect(
      classifyStdioConnectFailure("failed", {
        stderr: "The system cannot find the path specified.",
        exitCode: 1,
      })
    ).toBe("spawn_failed");
    expect(
      classifyStdioConnectFailure("failed", {
        stderr: "The system cannot find the file specified.",
        exitCode: 1,
      })
    ).toBe("spawn_failed");
    expect(
      classifyStdioConnectFailure("failed", {
        stderr: "'FOO' is NOT RECOGNIZED as an internal or external command",
        exitCode: 9009,
      })
    ).toBe("spawn_failed");
  });

  it("classifies started-then-failed as handshake_failed", () => {
    expect(
      classifyStdioConnectFailure("MCP error -32000: Connection closed", {
        exitCode: 1,
        stderr: "",
      })
    ).toBe("handshake_failed");
    expect(
      classifyStdioConnectFailure("connect failed", {
        exitCode: 0,
        stderr: "garbage",
        sawStdout: true,
      })
    ).toBe("handshake_failed");
    expect(
      classifyStdioConnectFailure("Invalid JSON-RPC", { exitCode: 1, sawStdout: true })
    ).toBe("handshake_failed");
  });

  it("integration: missing command spawn_failed; immediate exit handshake_failed", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item54-"));
    const configPath = path.join(testDir, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            miss: { command: "no-such-schema-budget-cmd-xyz", args: [] },
            exit0: { command: process.execPath, args: ["-e", "process.exit(0)"] },
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    const { servers } = await discoverFromMcpConfig(configPath, { timeoutMs: 5_000 });
    expect(servers.find((s) => s.name === "miss")?.status).toBe("spawn_failed");
    expect(servers.find((s) => s.name === "exit0")?.status).toBe("handshake_failed");
    await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
});
