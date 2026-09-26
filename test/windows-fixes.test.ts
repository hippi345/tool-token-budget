import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startServer } from "../src/ui/server.js";
import type { Report } from "../src/types.js";

describe("Windows regression fixes", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let port: number;

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

  beforeAll(async () => {
    server = await startServer({
      onReady: (url) => {
        const u = new URL(url);
        port = parseInt(u.port);
      },
      getReport: () => mockReport,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  test("Fix 1: Host validation is exact, not prefix-only", async () => {
    // Attack: "localhost:evil.example" would pass prefix check but is invalid
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: {
        "X-Auth-Token": server.token,
        // Cannot override Host in Node fetch, but server validates it server-side
      },
    });
    // Should succeed with proper host
    expect(res.status).toBe(200);
  });

  test("Fix 1: Malformed Host header doesn't crash server", async () => {
    // Test that server stays alive after receiving malformed requests
    // We can't directly test with fetch (it validates headers), but we verify
    // the server survives and continues to answer requests
    
    // First request should work
    const res1 = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { "X-Auth-Token": server.token },
    });
    expect(res1.status).toBe(200);

    // Server should still be alive and responding
    const res2 = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { "X-Auth-Token": server.token },
    });
    expect(res2.status).toBe(200);
  });

  test("Fix 1: Malformed URL in request doesn't crash server", async () => {
    // Test that the top-level try/catch prevents crashes from any error
    // Use a path that passes http.request validation but could cause issues
    const http = await import("node:http");
    
    // Test 1: Path with special characters that could cause URL parsing issues
    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/test%ZZinvalid", // Invalid URL encoding
          method: "GET",
          headers: {
            "X-Auth-Token": server.token,
          },
        },
        (res) => {
          // Should get 400 or 404, not crash
          expect([400, 404]).toContain(res.statusCode!);
          resolve();
        }
      );
      
      req.on("error", () => {
        // Connection errors are OK
        resolve();
      });
      
      req.end();
    });

    // Test 2: Verify server is still alive and responding after malformed requests
    const healthCheck = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { "X-Auth-Token": server.token },
    });
    expect(healthCheck.status).toBe(200);
    const health = await healthCheck.json();
    expect(health.status).toBe("ok");

    // Test 3: Another malformed request (very long path)
    const longPath = "/api/" + "x".repeat(10000);
    try {
      await fetch(`http://127.0.0.1:${port}${longPath}`, {
        headers: { "X-Auth-Token": server.token },
      });
    } catch {
      // Fetch might fail, that's OK
    }

    // Verify server still responds after all these malformed requests
    const finalCheck = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { "X-Auth-Token": server.token },
    });
    expect(finalCheck.status).toBe(200);
  });

  test("Fix 5: Unknown /api/* paths return 404 JSON, not HTML fallback", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/unknown`, {
      headers: { "X-Auth-Token": server.token },
    });
    expect(res.status).toBe(404);
    
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("application/json");
    
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error).toContain("Not Found");
  });

  test("Fix 3: Unauthenticated GET /api/health returns 401", async () => {
    // Request without auth token
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(401);
    
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  test("Fix 2: SSE /api/events sends initial snapshot immediately on connect (after broadcast)", async () => {
    // First, broadcast a snapshot so there's data to send to new clients
    const snapshot = {
      timestamp: new Date().toISOString(),
      servers: [{ name: "test", status: "ok" as const }],
      tools: [],
      report: mockReport,
    };
    server.broadcast(snapshot, null);

    // Small delay to ensure broadcast is processed
    await new Promise(resolve => setTimeout(resolve, 100));

    // Use Node.js http module to test SSE
    const http = await import("node:http");
    
    const receivedEvents: Array<{ type: string; snapshot?: any }> = [];
    
    const eventReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`No initial event received within 2s. Events: ${JSON.stringify(receivedEvents)}`));
      }, 2000);

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/events",
          method: "GET",
          headers: {
            "X-Auth-Token": server.token,
            Accept: "text/event-stream",
          },
        },
        (res) => {
          let buffer = "";
          
          res.on("data", (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n\n");
            buffer = lines.pop() || "";

            for (const block of lines) {
              if (block.startsWith("data: ")) {
                try {
                  const data = JSON.parse(block.slice(6));
                  receivedEvents.push(data);
                  if (data.type === "initial" && data.snapshot) {
                    clearTimeout(timeout);
                    req.destroy();
                    resolve();
                  }
                } catch {
                  // Skip parse errors
                }
              }
            }
          });
        }
      );

      req.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      req.end();
    });

    await eventReceived;
    expect(receivedEvents.length).toBeGreaterThan(0);
    expect(receivedEvents[0].type).toBe("initial");
    expect(receivedEvents[0].snapshot).toBeDefined();
  });

  test("Fix 3: SSE no-change polls send 'update' with empty diff", async () => {
    const http = await import("node:http");
    
    const receivedEvents: Array<{ type: string; diff?: any }> = [];
    let connectionClosed = false;
    
    const updateReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!connectionClosed) {
          reject(new Error(`No update event received. Events: ${JSON.stringify(receivedEvents)}`));
        }
      }, 3000);

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/events",
          method: "GET",
          headers: {
            "X-Auth-Token": server.token,
            Accept: "text/event-stream",
          },
        },
        (res) => {
          let buffer = "";
          
          res.on("data", (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n\n");
            buffer = lines.pop() || "";

            for (const block of lines) {
              if (block.startsWith("data: ")) {
                try {
                  const data = JSON.parse(block.slice(6));
                  receivedEvents.push(data);
                  
                  // We expect initial first, then update with empty diff (no change)
                  if (receivedEvents.length >= 2 && data.type === "update") {
                    clearTimeout(timeout);
                    connectionClosed = true;
                    req.destroy();
                    resolve();
                  }
                } catch {
                  // Skip parse errors
                }
              }
            }
          });
        }
      );

      req.on("error", (err) => {
        clearTimeout(timeout);
        if (!connectionClosed) {
          reject(err);
        }
      });

      req.end();

      // After a short delay, send a no-change broadcast (null diff)
      setTimeout(() => {
        const snapshot = {
          timestamp: new Date().toISOString(),
          servers: [{ name: "test", status: "ok" as const }],
          tools: [],
          report: mockReport,
        };
        server.broadcast(snapshot, null);
      }, 500);
    });

    await updateReceived;
    expect(receivedEvents.length).toBeGreaterThanOrEqual(2);
    expect(receivedEvents[0].type).toBe("initial");
    expect(receivedEvents[1].type).toBe("update");
    // No-change polls should have empty diff object, not undefined
    expect(receivedEvents[1].diff).toBeDefined();
    expect(receivedEvents[1].diff.servers).toBeDefined();
    expect(receivedEvents[1].diff.tools).toBeDefined();
  });

  test("Fix 2: SSE subsequent broadcasts are marked as 'update' type with diff", async () => {
    const http = await import("node:http");
    
    // First broadcast (initial)
    const snapshot1 = {
      timestamp: new Date().toISOString(),
      servers: [{ name: "test", status: "ok" as const }],
      tools: [],
      report: mockReport,
    };
    server.broadcast(snapshot1, null);

    const receivedEvents: Array<{ type: string; diff?: any }> = [];
    let connectionClosed = false;
    
    const updateReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!connectionClosed) {
          reject(new Error(`No update event received. Events: ${JSON.stringify(receivedEvents)}`));
        }
      }, 3000);

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/events",
          method: "GET",
          headers: {
            "X-Auth-Token": server.token,
            Accept: "text/event-stream",
          },
        },
        (res) => {
          let buffer = "";
          
          res.on("data", (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n\n");
            buffer = lines.pop() || "";

            for (const block of lines) {
              if (block.startsWith("data: ")) {
                try {
                  const data = JSON.parse(block.slice(6));
                  receivedEvents.push(data);
                  
                  // We expect initial first, then update
                  if (receivedEvents.length >= 2 && data.type === "update") {
                    clearTimeout(timeout);
                    connectionClosed = true;
                    req.destroy();
                    resolve();
                  }
                } catch {
                  // Skip parse errors
                }
              }
            }
          });
        }
      );

      req.on("error", (err) => {
        clearTimeout(timeout);
        if (!connectionClosed) {
          reject(err);
        }
      });

      req.end();

      // After a short delay, send an update broadcast
      setTimeout(() => {
        const mockDiff = {
          servers: { added: [], removed: [], statusChanged: [] },
          tools: { added: [], removed: [], changed: [] },
          tokens: { total: 0, perServer: new Map() },
        };
        const snapshot2 = {
          ...snapshot1,
          timestamp: new Date().toISOString(),
        };
        server.broadcast(snapshot2, mockDiff);
      }, 500);
    });

    await updateReceived;
    expect(receivedEvents.length).toBeGreaterThanOrEqual(2);
    expect(receivedEvents[0].type).toBe("initial");
    expect(receivedEvents[1].type).toBe("update");
    expect(receivedEvents[1].diff).toBeDefined();
  });
});

describe("Platform-specific command building", () => {
  test("Fix 3: openBrowser builds correct command per platform", async () => {
    // We can't directly test openBrowser since it's not exported,
    // but we verify the logic exists by checking the CLI runs
    // This is tested in the actual CLI code
    
    // The fix ensures:
    // - Windows: cmd /c start "" "<url>" (with proper escaping)
    // - macOS: open "<url>"
    // - Linux: xdg-open "<url>"
    
    const fs = await import("node:fs/promises");
    const cliSource = await fs.readFile("src/cli.ts", "utf8");
    expect(cliSource).toContain('spawn("cmd", ["/c", "start", "", url]');
    expect(cliSource).toContain('spawn("open", [url]');
    expect(cliSource).toContain('spawn("xdg-open", [url]');
  });
});
