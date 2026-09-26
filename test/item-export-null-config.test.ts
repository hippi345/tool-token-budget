import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer } from "../src/ui/server.js";
import type { Report } from "../src/types.js";
import path from "node:path";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";

const mockReport: Report = {
  generatedAt: new Date().toISOString(),
  tokenizerId: "o200k_base",
  totals: { estTokens: 10, toolCount: 1, serverCount: 1, findingCount: 0 },
  tools: [
    {
      server: "s",
      name: "t",
      estTokens: 10,
      breakdown: { name: 1, description: 1, schema: 8 },
      shareOfServer: 1,
      shareOfAll: 1,
    },
  ],
  servers: [{ name: "s", status: "ok" }],
  findings: [],
};

describe("export with null MCP config", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let port: number;
  let testDir: string;
  let mcpPath: string;

  beforeAll(async () => {
    testDir = await mkdtemp(path.join(os.tmpdir(), "export-null-"));
    const cursorDir = path.join(testDir, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    mcpPath = path.join(cursorDir, "mcp.json");
    await writeFile(mcpPath, "null\n", "utf8");

    server = await startServer({
      cwd: testDir,
      configPath: mcpPath,
      originalConfig: null,
      getReport: () => mockReport,
      onReady: (url) => {
        port = parseInt(new URL(url).port, 10);
      },
    });
  });

  afterAll(async () => {
    await server.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("returns 422 with a clear message (not a 500 null dereference)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/export`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ policy: {}, clientId: "cursor-project" }),
    });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toMatch(/missing or invalid/i);
    expect(text).not.toMatch(/Cannot read properties of null/i);
  });
});
