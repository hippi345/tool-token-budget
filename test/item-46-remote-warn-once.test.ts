import { describe, it, expect } from "vitest";
import { discoverFromMcpConfig } from "../src/discover/fromMcpConfig.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("item 46: remote skip warning once per server", () => {
  it("warns only once per remote server across repeated discover calls", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item46-"));
    const configPath = path.join(testDir, "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            remote: { url: "https://example.com/mcp" },
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const warnings: string[] = [];
    const warned = new Set<string>();
    const onWarn = (msg: string) => warnings.push(msg);

    await discoverFromMcpConfig(configPath, { onWarn, warnedRemoteServers: warned });
    await discoverFromMcpConfig(configPath, { onWarn, warnedRemoteServers: warned });
    await discoverFromMcpConfig(configPath, { onWarn, warnedRemoteServers: warned });

    const remoteWarnings = warnings.filter((w) => w.includes("skipping remote/OAuth server"));
    expect(remoteWarnings).toHaveLength(1);

    await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
});
