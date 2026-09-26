import { describe, it, expect, afterEach } from "vitest";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { apiGet, closeServer } from "./helpers/uiServer.js";
import type { Report } from "../src/types.js";

const minimalReport: Report = {
  generatedAt: new Date().toISOString(),
  tokenizerId: "openai:o200k",
  totals: { estTokens: 10, toolCount: 1, serverCount: 1, findingCount: 0 },
  tools: [],
  servers: [{ name: "stub", status: "ok" }],
  findings: [],
};

describe("stage3d UI default client", () => {
  let server: ServerInstance | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
  });

  it("stage3d-ui-default-client-health", async () => {
    server = await startServer({
      onReady: () => {},
      getReport: () => minimalReport,
      defaultClientId: "cursor-global",
      authToken: "test-token",
    });
    const res = await apiGet(server, "/api/health");
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { defaultClientId?: string | null };
    expect(body.defaultClientId).toBe("cursor-global");
  });
});
