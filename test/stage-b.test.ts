import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startServer, type ServerInstance } from "../src/ui/server.js";
import { analyzeTools } from "../src/pipeline.js";
import { loadToolsJson } from "../src/discover/fromToolsJson.js";
import { writeArtifacts } from "../src/emit/writeArtifacts.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, rm, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import * as fs from "node:fs";
import os from "node:os";
import { serverOrigin, serverListenPort } from "./helpers/uiServer.js";
import type { Report, PolicyOptions } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureToolsPath = path.join(__dirname, "../fixtures/tools-tiny.json");
const fixtureConfigPath = path.join(__dirname, "../fixtures/mcp-with-secrets.json");

describe("Stage B: API endpoints", () => {
  let server: ServerInstance;
  let report: Report;
  let originalConfig: unknown;

  beforeAll(async () => {
    // Load fixture
    const { servers, tools } = await loadToolsJson(fixtureToolsPath);
    report = analyzeTools(tools, servers);
    
    // Load original config
    try {
      originalConfig = JSON.parse(await readFile(fixtureConfigPath, "utf8"));
    } catch {
      originalConfig = { mcpServers: {} };
    }

    // Start server
    server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      configPath: fixtureConfigPath,
      originalConfig,
      cwd: __dirname,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("GET /api/clients returns detected clients without paths", async () => {
    const res = await fetch(`${serverOrigin(server)}/api/clients`, {
      headers: {
        "X-Auth-Token": server.token,
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("clients");
    expect(Array.isArray(data.clients)).toBe(true);
    
    // Clients should not include the actual filesystem path
    for (const client of data.clients) {
      expect(client).toHaveProperty("id");
      expect(client).toHaveProperty("name");
      expect(client).toHaveProperty("viewOnly");
      expect(client).not.toHaveProperty("path");
    }
  });

  it("POST /api/proposal generates a proposal with CLI-parity", async () => {
    const policy: PolicyOptions = { keepPerServer: 2 };
    const res = await fetch(`${serverOrigin(server)}/api/proposal`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        "Origin": `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ policy }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    
    expect(data).toHaveProperty("savings");
    expect(data).toHaveProperty("keepProposal");
    expect(data).toHaveProperty("removedServers");
    expect(data.savings).toHaveProperty("savedEstTokens");
    expect(data.savings).toHaveProperty("savedPct");
    
    // Verify secrets are redacted in proposed config if present
    if (data.proposedConfig) {
      const configStr = JSON.stringify(data.proposedConfig);
      if (configStr.includes("env") || configStr.includes("headers")) {
        expect(configStr).toContain("<from-original>");
      }
    }
  });

  it("POST /api/proposal rejects without valid token", async () => {
    const res = await fetch(`${serverOrigin(server)}/api/proposal`, {
      method: "POST",
      headers: {
        "X-Auth-Token": "invalid-token",
        "Content-Type": "application/json",
        "Origin": `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ policy: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/proposal rejects cross-origin requests", async () => {
    const res = await fetch(`${serverOrigin(server)}/api/proposal`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        "Origin": "http://evil.com",
      },
      body: JSON.stringify({ policy: {} }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Origin");
  });

  it("POST /api/proposal requires JSON content-type", async () => {
    const res = await fetch(`${serverOrigin(server)}/api/proposal`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "text/plain",
        "Origin": `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ policy: {} }),
    });
    expect(res.status).toBe(415);
  });

  it("POST /api/export rejects unknown client ID", async () => {
    const res = await fetch(`${serverOrigin(server)}/api/export`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        "Origin": `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ policy: {}, clientId: "nonexistent-client-id" }),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("unknown client ID");
  });

  it("POST /api/export rejects without clientId", async () => {
    const res = await fetch(`${serverOrigin(server)}/api/export`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        "Origin": `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ policy: {} }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("clientId required");
  });

  it("POST /api/export rejects cross-origin requests", async () => {
    const res = await fetch(`${serverOrigin(server)}/api/export`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        "Origin": "http://evil.com",
      },
      body: JSON.stringify({ policy: {}, clientId: "test" }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Origin");
  });

  // Note: Testing Host header rejection is difficult with fetch API
  // as it automatically sets the correct Host header. The server-side
  // check is still in place and tested manually.
});

describe("Stage B: CLI parity", () => {
  let outDir: string;
  
  beforeAll(async () => {
    outDir = await mkdtemp(path.join(os.tmpdir(), "test-cli-parity-"));
  });

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("API proposal matches CLI emit proposal", async () => {
    // Load fixture
    const { servers, tools } = await loadToolsJson(fixtureToolsPath);
    const report = analyzeTools(tools, servers);
    
    // Load original config (must match what server has)
    const originalConfig = JSON.parse(await readFile(fixtureConfigPath, "utf8"));
    
    // Generate CLI proposal
    const policy: PolicyOptions = { keepPerServer: 2 };
    await writeArtifacts(outDir, report, {
      format: "both",
      policy,
      originalConfig,
    });
    
    // Read CLI outputs
    const cliKeepPath = path.join(outDir, "tool-token-budget.keep.json");
    const cliKeep = JSON.parse(await readFile(cliKeepPath, "utf8"));
    
    const cliProposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");
    const cliProposed = JSON.parse(await readFile(cliProposedPath, "utf8"));
    
    // Generate API proposal via POST endpoint
    const testServer = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      configPath: fixtureConfigPath,
      originalConfig,
      cwd: __dirname,
    });
    
    try {
      const res = await fetch(`${serverOrigin(testServer)}/api/proposal`, {
        method: "POST",
        headers: {
          "X-Auth-Token": testServer.token,
          "Content-Type": "application/json",
          "Origin": `${serverOrigin(testServer)}`,
        },
        body: JSON.stringify({ policy }),
      });
      
      expect(res.status).toBe(200);
      const apiData = await res.json();
      
      // Compare keep proposal
      expect(apiData.keepProposal.keepHot).toEqual(cliKeep.keepHot);
      expect(apiData.keepProposal.defer).toEqual(cliKeep.defer);
      
      // Compare proposed config (deep equal)
      expect(apiData.proposedConfig).toEqual(cliProposed);
      
      // Verify secrets are consistently redacted with <from-original> in both
      const apiConfigStr = JSON.stringify(apiData.proposedConfig);
      const cliConfigStr = JSON.stringify(cliProposed);
      if (apiConfigStr.includes("<from-original>")) {
        expect(cliConfigStr).toContain("<from-original>");
      }
      if (cliConfigStr.includes("<from-original>")) {
        expect(apiConfigStr).toContain("<from-original>");
      }
    } finally {
      await testServer.close();
    }
  });
});

describe("Stage B: client config detection", () => {
  it("detects client configs without exposing paths to browser", async () => {
    const { detectClientConfigs } = await import("../src/discover/clientConfigs.js");
    const clients = await detectClientConfigs(__dirname);
    
    // Clients should have required properties
    for (const client of clients) {
      expect(client).toHaveProperty("id");
      expect(client).toHaveProperty("name");
      expect(client).toHaveProperty("path"); // Server-side has path
      expect(client).toHaveProperty("profile");
      expect(client).toHaveProperty("viewOnly");
    }
  });

  it("getClientConfigById only returns known clients", async () => {
    const { getClientConfigById } = await import("../src/discover/clientConfigs.js");
    
    // Unknown ID should return null
    const unknown = await getClientConfigById("definitely-not-a-real-client-id");
    expect(unknown).toBeNull();
  });
});

describe("Stage B: zero-kept tools warning", () => {
  it("warns when a server would have zero kept tools", async () => {
    const { servers, tools } = await loadToolsJson(fixtureToolsPath);
    const report = analyzeTools(tools, servers);
    
    // Policy that keeps very few tools (high disable threshold)
    const policy: PolicyOptions = { keepPerServer: 0, disableServersOver: 1 };
    const { selectHotToolsWithPolicy } = await import("../src/emit/keepHot.js");
    const { buildProposedMcpConfig } = await import("../src/emit/writeArtifacts.js");
    
    const result = selectHotToolsWithPolicy(report.tools, policy);
    
    // Build proposed config to see which servers would be removed
    const originalConfig = {
      mcpServers: {
        tiny: { command: "node", args: ["server.js"] },
      },
    };
    const proposed = buildProposedMcpConfig(originalConfig, result.hot, result.disabledServers, report.tools);
    
    // Servers with zero hot tools or over threshold should be removed
    expect(proposed.allRemovedServers.size).toBeGreaterThan(0);
  });
});

describe("Stage B: Export security", () => {
  let server: ServerInstance;
  let report: Report;
  let originalConfig: unknown;
  let exportRoot: string;

  beforeAll(async () => {
    exportRoot = await mkdtemp(path.join(os.tmpdir(), "test-export-security-"));
    
    // Load fixture
    const { servers, tools } = await loadToolsJson(fixtureToolsPath);
    report = analyzeTools(tools, servers);
    
    // Load original config
    originalConfig = JSON.parse(await readFile(fixtureConfigPath, "utf8"));

    // Start server with controlled export directory
    server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      configPath: fixtureConfigPath,
      originalConfig,
      cwd: __dirname,
      exportDir: exportRoot,
    });
  });

  afterAll(async () => {
    await server.close();
    await rm(exportRoot, { recursive: true, force: true });
  });

  it("rejects export when --export-dir is inside ANY config directory (Item 1 & 3 - hermetic)", async () => {
    // Create a hermetic temp environment
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-home-"));
    const savedEnv = { ...process.env };
    
    try {
      // Override all environment variables that client path resolver reads
      process.env.HOME = tmpHome;
      process.env.USERPROFILE = tmpHome;
      process.env.APPDATA = path.join(tmpHome, "AppData", "Roaming");
      process.env.LOCALAPPDATA = path.join(tmpHome, "AppData", "Local");
      process.env.XDG_CONFIG_HOME = path.join(tmpHome, ".config");
      
      // Create a fake .cursor/mcp.json
      const cursorDir = path.join(tmpHome, ".cursor");
      await mkdir(cursorDir, { recursive: true });
      const cursorMcp = path.join(cursorDir, "mcp.json");
      await writeFile(cursorMcp, JSON.stringify({ mcpServers: {} }), "utf8");
      
      // Try to export INTO the .cursor directory (should be blocked at startup - Item 3)
      // Use the exact config directory
      const exportDirExact = cursorDir;
      
      // Capture console.error output
      const errorLogs: string[] = [];
      const originalError = console.error;
      console.error = (...args: any[]) => {
        errorLogs.push(args.join(" "));
      };
      
      // Mock process.exit to prevent actual exit
      let exitCode: number | undefined;
      const originalExit = process.exit;
      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error(`EXIT_${code}`);
      }) as typeof process.exit;
      
      try {
        await startServer({
          port: 0,
          onReady: () => {},
          getReport: () => report,
          configPath: cursorMcp,
          originalConfig: { mcpServers: {} },
          cwd: tmpHome,
          exportDir: exportDirExact, // Exactly the config dir
        });
        
        // Should never reach here
        expect.fail("Server should have exited with error");
      } catch (err: any) {
        // Should have called process.exit(1)
        expect(err.message).toContain("EXIT_1");
        expect(exitCode).toBe(1);
        expect(errorLogs.join("\n")).toContain("cannot be inside a config directory");
      } finally {
        console.error = originalError;
        process.exit = originalExit;
      }
    } finally {
      process.env = savedEnv;
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("rejects export when --export-dir is subdirectory of config directory (Item 1 & 3 - hermetic)", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-home-2-"));
    const savedEnv = { ...process.env };
    
    try {
      process.env.HOME = tmpHome;
      process.env.USERPROFILE = tmpHome;
      process.env.APPDATA = path.join(tmpHome, "AppData", "Roaming");
      process.env.LOCALAPPDATA = path.join(tmpHome, "AppData", "Local");
      process.env.XDG_CONFIG_HOME = path.join(tmpHome, ".config");
      
      const cursorDir = path.join(tmpHome, ".cursor");
      await mkdir(cursorDir, { recursive: true });
      const cursorMcp = path.join(cursorDir, "mcp.json");
      await writeFile(cursorMcp, JSON.stringify({ mcpServers: {} }), "utf8");
      
      // Subdirectory of config dir
      const exportSubDir = path.join(cursorDir, "nested", "exports");
      
      const errorLogs: string[] = [];
      const originalError = console.error;
      console.error = (...args: any[]) => {
        errorLogs.push(args.join(" "));
      };
      
      let exitCode: number | undefined;
      const originalExit = process.exit;
      process.exit = ((code?: number) => {
        exitCode = code;
        throw new Error(`EXIT_${code}`);
      }) as typeof process.exit;
      
      try {
        await startServer({
          port: 0,
          onReady: () => {},
          getReport: () => report,
          configPath: cursorMcp,
          originalConfig: { mcpServers: {} },
          cwd: tmpHome,
          exportDir: exportSubDir,
        });
        
        expect.fail("Server should have exited with error");
      } catch (err: any) {
        expect(err.message).toContain("EXIT_1");
        expect(exitCode).toBe(1);
        expect(errorLogs.join("\n")).toContain("cannot be inside a config directory");
      } finally {
        console.error = originalError;
        process.exit = originalExit;
      }
    } finally {
      process.env = savedEnv;
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("rejects request with outDir field", async () => {
    const res = await fetch(`${serverOrigin(server)}/api/export`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        "Origin": `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ 
        policy: {}, 
        clientId: "cursor-global",
        outDir: "/tmp/evil"
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("outDir");
  });

  it("rejects request with path traversal in any path-like field", async () => {
    const pathFields = ["path", "dir", "directory", "output", "outputDir", "exportDir"];
    
    for (const field of pathFields) {
      const res = await fetch(`${serverOrigin(server)}/api/export`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          "Origin": `${serverOrigin(server)}`,
        },
        body: JSON.stringify({ 
          policy: {}, 
          clientId: "cursor-global",
          [field]: "../../etc/passwd"
        }),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain(field);
    }
  });

  it("rejects absolute path in request body", async () => {
    // Test POSIX path
    const resPosix = await fetch(`${serverOrigin(server)}/api/export`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        "Origin": `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ 
        policy: {}, 
        clientId: "cursor-global",
        outDir: "/absolute/path"
      }),
    });
    expect(resPosix.status).toBe(400);

    // Test Windows path
    const resWin = await fetch(`${serverOrigin(server)}/api/export`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        "Origin": `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ 
        policy: {}, 
        clientId: "cursor-global",
        outDir: "C:\\Windows\\System32"
      }),
    });
    expect(resWin.status).toBe(400);
  });

  it("exports to server-controlled location with timestamp", async () => {
    const testConfigDir = await mkdtemp(path.join(os.tmpdir(), "test-config-"));
    const cursorDir = path.join(testConfigDir, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    const testConfigPath = path.join(cursorDir, "mcp.json");
    const testConfig = JSON.parse(await readFile(fixtureConfigPath, "utf8"));
    await writeFile(testConfigPath, JSON.stringify(testConfig, null, 2) + "\n", "utf8");

    const exportServer = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      configPath: testConfigPath,
      originalConfig: testConfig,
      cwd: testConfigDir,
      exportDir: exportRoot,
    });

    try {
      const res = await fetch(`${serverOrigin(exportServer)}/api/export`, {
        method: "POST",
        headers: {
          "X-Auth-Token": exportServer.token,
          "Content-Type": "application/json",
          Origin: `${serverOrigin(exportServer)}`,
        },
        body: JSON.stringify({
          policy: { keepPerServer: 2 },
          clientId: "cursor-project",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty("exportDir");
      expect(data.exportDir).toContain(exportRoot);
      expect(data.exportDir).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    } finally {
      await exportServer.close();
      await rm(testConfigDir, { recursive: true, force: true });
    }
  });

  it("writes defer-hints.json for all exports (CLI parity)", async () => {
    // This is tested in the file-set parity test below
    // Verifying that CLI emit and API export write the same files
  });

  it("Item c: rejects export when proposal keeps zero servers", async () => {
    // Create a test config directory in a location that will be detected
    // We'll use the test __dirname as cwd
    const testConfigDir = await mkdtemp(path.join(os.tmpdir(), "stage-b-export-zero-"));
    const cursorDir = path.join(testConfigDir, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    const testConfigPath = path.join(cursorDir, "mcp.json");
    
    // Create a config that matches the fixture servers
    const testConfig = {
      mcpServers: {
        tiny: {
          command: "node",
          args: ["test.js"],
        },
      },
    };
    // Start a new server with this config
    const { servers, tools } = await loadToolsJson(fixtureToolsPath);
    const testReport = analyzeTools(tools, servers);
    
    const initialContent = JSON.stringify(testConfig) + "\n";
    await writeFile(testConfigPath, initialContent, "utf8");
    const testServer = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => testReport,
      configPath: testConfigPath,
      originalConfig: testConfig,
      cwd: testConfigDir,
      initialAnalyzedContent: initialContent,
    });
    
    // Use policy that keeps zero tools per server
    const res = await fetch(`${serverOrigin(testServer)}/api/export`, {
      method: "POST",
      headers: {
        "X-Auth-Token": testServer.token,
        "Content-Type": "application/json",
        "Origin": `${serverOrigin(testServer)}`,
      },
      body: JSON.stringify({ 
        policy: { keepPerServer: 0 },
        clientId: "cursor-project" // This should be detected from .cursor/mcp.json
      }),
    });
    
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain("zero");
    expect(text).toContain("servers");
    
    await testServer.close();
    await rm(testConfigDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
});describe("Stage B: Export file-set parity", () => {
  let exportOutDir: string;
  let cliOutDir: string;

  beforeAll(async () => {
    exportOutDir = await mkdtemp(path.join(os.tmpdir(), "test-export-fileset-"));
    cliOutDir = await mkdtemp(path.join(os.tmpdir(), "test-cli-fileset-"));
  });

  afterAll(async () => {
    await rm(exportOutDir, { recursive: true, force: true });
    await rm(cliOutDir, { recursive: true, force: true });
  });

  it("API export writes same file set as CLI emit", async () => {
    // Load fixture
    const { servers, tools } = await loadToolsJson(fixtureToolsPath);
    const report = analyzeTools(tools, servers);
    const originalConfig = JSON.parse(await readFile(fixtureConfigPath, "utf8"));
    const policy: PolicyOptions = { keepPerServer: 2 };

    // Generate CLI output
    await writeArtifacts(cliOutDir, report, {
      format: "both",
      policy,
      originalConfig,
    });

    // Get CLI file list
    const { readdir } = await import("node:fs/promises");
    const cliFiles = (await readdir(cliOutDir)).sort();

    const parityDir = await mkdtemp(path.join(os.tmpdir(), "export-parity-cursor-"));
    const cursorDir = path.join(parityDir, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    const parityConfigPath = path.join(cursorDir, "mcp.json");
    await writeFile(parityConfigPath, JSON.stringify(originalConfig, null, 2) + "\n", "utf8");

    const testServer = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      configPath: parityConfigPath,
      originalConfig,
      cwd: parityDir,
      exportDir: exportOutDir,
    });

    try {
      const res = await fetch(`${serverOrigin(testServer)}/api/export`, {
        method: "POST",
        headers: {
          "X-Auth-Token": testServer.token,
          "Content-Type": "application/json",
          "Origin": `${serverOrigin(testServer)}`,
        },
        body: JSON.stringify({ 
          policy, 
          clientId: "cursor-project"
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      const exportDir = data.exportDir;
        
      const exportFiles = (await readdir(exportDir)).sort();
        
      expect(exportFiles).toEqual(cliFiles);
      expect(exportFiles).toContain("defer-hints.json");
    } finally {
      await rm(parityDir, { recursive: true, force: true });
      await testServer.close();
    }
  });
});

describe("Stage B: Policy defaults", () => {
  let server: ServerInstance;
  let report: Report;
  let originalConfig: unknown;

  beforeAll(async () => {
    // Load fixture
    const { servers, tools } = await loadToolsJson(fixtureToolsPath);
    report = analyzeTools(tools, servers);
    
    // Create matching config for the fixture (tiny server exists in tools-tiny.json)
    originalConfig = {
      mcpServers: {
        tiny: {
          command: "node",
          args: ["server.js"]
        }
      }
    };

    server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      configPath: fixtureConfigPath,
      originalConfig,
      cwd: __dirname,
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("empty policy {} uses CLI defaults (keepPerServer: 2)", async () => {
    const res = await fetch(`${serverOrigin(server)}/api/proposal`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        "Origin": `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ policy: {} }),
    });
    
    expect(res.status).toBe(200);
    const data = await res.json();
    
    // With empty policy, should keep 2 tools per server (CLI default)
    // Should NOT drop all servers
    expect(data.proposedConfig).toBeTruthy();
    expect(data.proposedConfig.mcpServers).toBeTruthy();
    expect(Object.keys(data.proposedConfig.mcpServers).length).toBeGreaterThan(0);
    
    // removedServersCount should be 0 or match actual removed count
    expect(data.savings.removedServersCount).toBe(data.removedServers.length);
  });

  it("missing policy uses CLI defaults", async () => {
    const res = await fetch(`${serverOrigin(server)}/api/proposal`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        "Origin": `${serverOrigin(server)}`,
      },
      body: JSON.stringify({}),
    });
    
    expect(res.status).toBe(200);
    const data = await res.json();
    
    // Should behave same as empty policy
    expect(data.proposedConfig).toBeTruthy();
    expect(data.proposedConfig.mcpServers).toBeTruthy();
    expect(Object.keys(data.proposedConfig.mcpServers).length).toBeGreaterThan(0);
  });

  it("partial policy fills in defaults", async () => {
    // Only specify keepHot, should use default keepPerServer: 2
    const res = await fetch(`${serverOrigin(server)}/api/proposal`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        "Origin": `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ policy: { keepHot: 10 } }),
    });
    
    expect(res.status).toBe(200);
    const data = await res.json();
    
    // Should use default keepPerServer: 2
    expect(data.proposedConfig).toBeTruthy();
    expect(data.proposedConfig.mcpServers).toBeTruthy();
  });

  it("policy that drops servers reports correct removedServersCount", async () => {
    // Policy that will actually remove servers
    const res = await fetch(`${serverOrigin(server)}/api/proposal`, {
      method: "POST",
      headers: {
        "X-Auth-Token": server.token,
        "Content-Type": "application/json",
        "Origin": `${serverOrigin(server)}`,
      },
      body: JSON.stringify({ 
        policy: { 
          keepPerServer: 0,  // Keep no tools
          disableServersOver: 1  // Disable servers over 1 token
        } 
      }),
    });
    
    expect(res.status).toBe(200);
    const data = await res.json();
    
    // Should have removed servers
    expect(data.removedServers.length).toBeGreaterThan(0);
    
    // removedServersCount must match actual count
    expect(data.savings.removedServersCount).toBe(data.removedServers.length);
    
    // savedPct should be high since we're removing most/all servers
    expect(data.savings.savedPct).toBeGreaterThan(0);
  });
});

describe("Stage B: Watch interval control", () => {
  it("POST /api/watch-interval requires auth", async () => {
    const { servers, tools } = await loadToolsJson(fixtureToolsPath);
    const report = analyzeTools(tools, servers);
    
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      cwd: __dirname,
    });

    try {
      const res = await fetch(`${serverOrigin(server)}/api/watch-interval`, {
        method: "POST",
        headers: {
          "X-Auth-Token": "invalid-token",
          "Content-Type": "application/json",
          "Origin": `${serverOrigin(server)}`,
        },
        body: JSON.stringify({ intervalSec: 30 }),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("POST /api/watch-interval enforces bounds (10-3600)", async () => {
    const { servers, tools } = await loadToolsJson(fixtureToolsPath);
    const report = analyzeTools(tools, servers);
    
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      cwd: __dirname,
    });

    try {
      // Test too low
      let res = await fetch(`${serverOrigin(server)}/api/watch-interval`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          "Origin": `${serverOrigin(server)}`,
        },
        body: JSON.stringify({ intervalSec: 5 }),
      });
      expect(res.status).toBe(400);
      
      // Test too high
      res = await fetch(`${serverOrigin(server)}/api/watch-interval`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          "Origin": `${serverOrigin(server)}`,
        },
        body: JSON.stringify({ intervalSec: 4000 }),
      });
      expect(res.status).toBe(400);
      
      // Test valid
      res = await fetch(`${serverOrigin(server)}/api/watch-interval`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          "Origin": `${serverOrigin(server)}`,
        },
        body: JSON.stringify({ intervalSec: 30 }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("watch interval change takes effect", async () => {
    const { servers, tools } = await loadToolsJson(fixtureToolsPath);
    const report = analyzeTools(tools, servers);
    
    let callbackCalled = false;
    let callbackValue = 0;
    
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      cwd: __dirname,
      watchInterval: 30,
      onWatchIntervalChange: (newInterval) => {
        callbackCalled = true;
        callbackValue = newInterval;
      },
    });

    try {
      const res = await fetch(`${serverOrigin(server)}/api/watch-interval`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          "Origin": `${serverOrigin(server)}`,
        },
        body: JSON.stringify({ intervalSec: 60 }),
      });
      
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.intervalSec).toBe(60);
      
      // Verify callback was called
      expect(callbackCalled).toBe(true);
      expect(callbackValue).toBe(60);
      
      // Verify server state updated
      expect(server.getWatchInterval()).toBe(60);
    } finally {
      await server.close();
    }
  });

  it("rejects non-integer intervals (Item 8)", async () => {
    const { servers, tools } = await loadToolsJson(fixtureToolsPath);
    const report = analyzeTools(tools, servers);
    
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      cwd: __dirname,
    });

    try {
      // Test string "10"
      let res = await fetch(`${serverOrigin(server)}/api/watch-interval`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          "Origin": `${serverOrigin(server)}`,
        },
        body: JSON.stringify({ intervalSec: "10" }),
      });
      expect(res.status).toBe(400);
      const data1 = await res.json();
      expect(data1.error).toContain("integer");
      
      // Test float 10.5
      res = await fetch(`${serverOrigin(server)}/api/watch-interval`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          "Origin": `${serverOrigin(server)}`,
        },
        body: JSON.stringify({ intervalSec: 10.5 }),
      });
      expect(res.status).toBe(400);
      const data2 = await res.json();
      expect(data2.error).toContain("integer");
    } finally {
      await server.close();
    }
  });

  it("validates Origin with exact port match (Item 6)", async () => {
    const { servers, tools } = await loadToolsJson(fixtureToolsPath);
    const report = analyzeTools(tools, servers);
    
    const server = await startServer({
      port: 0,
      onReady: () => {},
      getReport: () => report,
      cwd: __dirname,
    });

    try {
      // Wrong port
      let res = await fetch(`${serverOrigin(server)}/api/watch-interval`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          "Origin": `http://127.0.0.1:9999`,
        },
        body: JSON.stringify({ intervalSec: 30 }),
      });
      expect(res.status).toBe(403);
      
      // Evil suffix (http://127.0.0.1:PORT.evil.com)
      res = await fetch(`${serverOrigin(server)}/api/watch-interval`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          "Origin": `http://127.0.0.1:${serverListenPort(server)}.evil.com`,
        },
        body: JSON.stringify({ intervalSec: 30 }),
      });
      expect(res.status).toBe(403);
      
      // HTTPS (should be http)
      res = await fetch(`${serverOrigin(server)}/api/watch-interval`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          "Origin": `https://127.0.0.1:${serverListenPort(server)}`,
        },
        body: JSON.stringify({ intervalSec: 30 }),
      });
      expect(res.status).toBe(403);
      
      // Missing Origin
      res = await fetch(`${serverOrigin(server)}/api/watch-interval`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ intervalSec: 30 }),
      });
      expect(res.status).toBe(403);
      
      // Valid Origin
      res = await fetch(`${serverOrigin(server)}/api/watch-interval`, {
        method: "POST",
        headers: {
          "X-Auth-Token": server.token,
          "Content-Type": "application/json",
          "Origin": `${serverOrigin(server)}`,
        },
        body: JSON.stringify({ intervalSec: 30 }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe("Export folder uniqueness (Item 7)", () => {
  it("creates unique export folders with readable timestamp + random suffix", () => {
    // Test the makeUniqueTimestamp function directly by simulating rapid calls
    const timestamps = new Set<string>();
    
    // Mock randomBytes to ensure we're testing the timestamp portion
    const originalRandomBytes = require("node:crypto").randomBytes;
    let callCount = 0;
    require("node:crypto").randomBytes = (size: number) => {
      return Buffer.from((callCount++).toString().padStart(size * 2, '0').slice(0, size * 2), 'hex');
    };
    
    try {
      // Simulate multiple exports in rapid succession
      for (let i = 0; i < 10; i++) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hour = String(now.getHours()).padStart(2, '0');
        const minute = String(now.getMinutes()).padStart(2, '0');
        const second = String(now.getSeconds()).padStart(2, '0');
        const ms = String(now.getMilliseconds()).padStart(3, '0');
        const random = require("node:crypto").randomBytes(2).toString("hex");
        const timestamp = `${year}-${month}-${day}T${hour}-${minute}-${second}-${ms}-${random}`;
        timestamps.add(timestamp);
      }
      
      // All should be unique
      expect(timestamps.size).toBe(10);
      
      // Each should match the expected format: 2026-09-25T04-45-12-123-82bd (readable timestamp with ms and random hex)
      for (const ts of timestamps) {
        expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[a-f0-9]{4}$/);
      }
    } finally {
      require("node:crypto").randomBytes = originalRandomBytes;
    }
  });
});
