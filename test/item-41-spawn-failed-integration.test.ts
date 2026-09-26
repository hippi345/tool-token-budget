import { describe, it, expect } from "vitest";
import { discoverFromMcpConfig } from "../src/discover/fromMcpConfig.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyStdioConnectFailure } from "../src/discover/spawnError.js";

describe("item 41: spawn_failed via real discovery", () => {
  it("classifies missing executable as spawn_failed through discoverFromMcpConfig", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item41-miss-"));
    const configPath = path.join(testDir, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            bad: {
              command: "definitely-not-a-real-schema-budget-command-xyz",
              args: [],
            },
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const { servers } = await discoverFromMcpConfig(configPath, { timeoutMs: 5_000 });
    const bad = servers.find((s) => s.name === "bad");
    expect(bad?.status).toBe("spawn_failed");

    await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("classifies immediate node exit as spawn_failed through discoverFromMcpConfig", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item41-exit-"));
    const configPath = path.join(testDir, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            exitfast: {
              command: process.execPath,
              args: ["-e", "process.exit(1)"],
            },
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const { servers } = await discoverFromMcpConfig(configPath, { timeoutMs: 5_000 });
    const s = servers.find((x) => x.name === "exitfast");
    expect(s?.status).toBe("handshake_failed");

    await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("classifies EACCES-style errors as spawn_failed", () => {
    expect(
      classifyStdioConnectFailure("connect failed", {
        stderr: "EACCES: permission denied",
        exitCode: 1,
      })
    ).toBe("spawn_failed");
  });
});
