import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import type { Report } from "../src/types.js";
import { readPersistedUiAuthToken, uiAuthTokenPath } from "../src/ui/uiAuthToken.js";

const mockReport: Report = {
  generatedAt: new Date().toISOString(),
  tokenizerId: "o200k_base",
  totals: { estTokens: 100, toolCount: 1, serverCount: 1, findingCount: 0 },
  tools: [
    {
      server: "test",
      name: "tool1",
      estTokens: 100,
      breakdown: { name: 10, description: 30, schema: 60 },
      shareOfServer: 1.0,
      shareOfAll: 1.0,
    },
  ],
  servers: [{ name: "test", status: "ok", transportSummary: "stdio:node" }],
  findings: [],
};

async function startTestServer(
  port: number,
  cacheDir: string,
  authToken?: string
): Promise<ServerInstance> {
  return startServer({
    port,
    uiAuthCacheDir: cacheDir,
    authToken,
    onReady: () => {},
    getReport: () => mockReport,
  });
}

describe("Stage 1 review round 7", () => {
  afterEach(() => {
    // no vi mocks in this file
  });

  it("stage1-r7-item1a: token is persisted and reused across two server starts on the same port", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "r7-ui-auth-"));
    const port = 38_471;
    const server1 = await startTestServer(port, cacheDir);
    const token1 = server1.token;
    await server1.close();

    const server2 = await startTestServer(port, cacheDir);
    expect(server2.token).toBe(token1);

    const parsed = new URL(server2.url);
    const res = await globalThis.fetch(`${parsed.origin}/api/report`, {
      headers: { "X-Auth-Token": token1 },
    });
    expect(res.status).toBe(200);

    await server2.close();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("stage1-r7-item1e: missing/corrupt token file is regenerated; file permissions restrictive on POSIX", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "r7-ui-auth-corrupt-"));
    const port = 38_472;
    const tokenPath = uiAuthTokenPath(port, cacheDir);
    await writeFile(tokenPath, "not-a-valid-token\n", "utf8");

    const serverCorrupt = await startTestServer(port, cacheDir);
    expect(serverCorrupt.token).toMatch(/^[a-f0-9]{64}$/i);
    expect(readPersistedUiAuthToken(port, cacheDir)).toBe(serverCorrupt.token);
    await serverCorrupt.close();

    const portMissing = 38_473;
    const serverMissing = await startTestServer(portMissing, cacheDir);
    expect(readPersistedUiAuthToken(portMissing, cacheDir)).toBe(serverMissing.token);
    await serverMissing.close();

    if (process.platform !== "win32") {
      const fileStat = await stat(uiAuthTokenPath(port, cacheDir));
      expect(fileStat.mode & 0o777).toBe(0o600);
    }

    await rm(cacheDir, { recursive: true, force: true });
  });
});
