import { describe, it, expect } from "vitest";
import { classifyStdioConnectFailure } from "../src/discover/spawnError.js";
import { discoverFromMcpConfig } from "../src/discover/fromMcpConfig.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("item 60: launch failures are spawn_failed without stdout", () => {
  it("matches Windows cannot-find-path/file messages as spawn_failed", () => {
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
  });

  it("matches npm 10 E404 stderr variants as spawn_failed when no stdout", () => {
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
  });

  it("keeps stdout-before-failure as handshake_failed", () => {
    expect(
      classifyStdioConnectFailure("connect failed", {
        stderr: "npm ERR! code E404",
        exitCode: 1,
        sawStdout: true,
      })
    ).toBe("handshake_failed");
  });

  it("integration: npm E404 stderr only (no stdout) is spawn_failed via discovery", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item60-npm-"));
    const configPath = path.join(testDir, "mcp.json");
    const e404Script = [
      "process.stderr.write('npm error code E404\\n');",
      "process.exit(1);",
    ].join("");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            npm404: {
              command: process.execPath,
              args: ["-e", e404Script],
            },
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    const { servers } = await discoverFromMcpConfig(configPath, { timeoutMs: 5_000 });
    expect(servers.find((s) => s.name === "npm404")?.status).toBe("spawn_failed");
    await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
});
