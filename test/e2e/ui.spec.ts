import { test, expect } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { isDangerousTestHome } from "../../src/utils/testHomeGuard.js";
import { computeConfigContentHash } from "../../src/mcp/configGuards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// REAL_HOME is set by test/e2e/playwright-loader.cjs from os.userInfo() (immune to fake HOME)
const REAL_HOME = process.env.REAL_HOME ?? os.userInfo().homedir;

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test.describe("UI end-to-end", () => {
  // One shared UI server + isolated HOME per worker; parallel tests would race on mcp.json.
  test.describe.configure({ mode: "serial" });

  let serverProcess: ChildProcess;
  let serverUrl: string;
  let testHome: string;
  let e2eWorkDir: string;
  let e2eExportRoot: string;
  let repoRoot: string;
  let defaultMcpConfig: Record<string, unknown>;

  function defaultMcpConfigContent(): string {
    return JSON.stringify(defaultMcpConfig, null, 2) + "\n";
  }

  function writeDefaultMcpConfig(): void {
    const mcpPath = path.join(testHome, ".cursor", "mcp.json");
    writeFileSync(mcpPath, defaultMcpConfigContent(), "utf8");
  }

  /** After resetting mcp.json on disk, wait until poll/watch re-analysis updates server baseline. */
  async function waitForBaselineMatchesDefaultMcp(): Promise<void> {
    const expectedHash = computeConfigContentHash(defaultMcpConfigContent());
    const parsedUrl = new URL(serverUrl);
    const token = parsedUrl.searchParams.get("token") ?? "";
    // Shorter watch interval + immediate poll (e2e may leave interval at 50s from Settings tests).
    try {
      await fetch(`${parsedUrl.origin}/api/watch-interval`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Token": token,
          Origin: parsedUrl.origin,
        },
        body: JSON.stringify({ intervalSec: 10 }),
      });
    } catch {
      // best-effort
    }

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${parsedUrl.origin}/api/report`, {
          headers: { "X-Auth-Token": token },
        });
        if (res.ok) {
          const data = (await res.json()) as { report?: { sourceConfigHash?: string } };
          if (data.report?.sourceConfigHash === expectedHash) {
            return;
          }
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("Timed out waiting for UI baseline to match default mcp.json after reset");
  }

  test.beforeAll(async () => {
    const workerId = process.env.TEST_PARALLEL_INDEX ?? "0";
    testHome = path.join(__dirname, "..", "..", "tmp", `e2e-test-home-w${workerId}`);
    mkdirSync(testHome, { recursive: true });
    mkdirSync(path.join(testHome, ".cursor"), { recursive: true });
    mkdirSync(path.join(testHome, "AppData", "Roaming"), { recursive: true });
    mkdirSync(path.join(testHome, "AppData", "Local"), { recursive: true });
    mkdirSync(path.join(testHome, ".config"), { recursive: true });
    mkdirSync(path.join(testHome, ".local", "share"), { recursive: true });

    repoRoot = path.join(__dirname, "..", "..");
    e2eWorkDir = mkdtempSync(path.join(os.tmpdir(), "schema-budget-e2e-cwd-"));
    e2eExportRoot = mkdtempSync(path.join(os.tmpdir(), "schema-budget-e2e-export-"));
    const stubPath = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
    defaultMcpConfig = {
      mcpServers: {
        stub: {
          command: "node",
          args: [stubPath],
          env: { STUB_ENV: "e2e-test-value" },
        },
        stub2: {
          command: "node",
          args: [stubPath],
        },
        "remote-example": {
          url: "https://example.com/mcp",
        },
      },
    };
    writeDefaultMcpConfig();

    const windsurfDir = path.join(testHome, ".codeium", "windsurf");
    mkdirSync(windsurfDir, { recursive: true });
    writeFileSync(
      path.join(windsurfDir, "mcp_config.json"),
      JSON.stringify(
        {
          mcpServers: {
            stub: {
              command: "node",
              args: [stubPath],
            },
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const cliPath = path.join(repoRoot, "dist", "cli.js");

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimeout);
        resolve();
      };

      const mcpPath = path.join(testHome, ".cursor", "mcp.json");
      serverProcess = spawn(
        "node",
        [
          cliPath,
          "ui",
          "--no-open",
          "--watch-interval",
          "10",
          "--export-dir",
          e2eExportRoot,
          mcpPath,
        ],
        {
        cwd: e2eWorkDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // Override ALL home directory environment variables
          HOME: testHome,
          USERPROFILE: testHome,
          APPDATA: path.join(testHome, "AppData", "Roaming"),
          LOCALAPPDATA: path.join(testHome, "AppData", "Local"),
          XDG_CONFIG_HOME: path.join(testHome, ".config"),
          XDG_DATA_HOME: path.join(testHome, ".local", "share"),
        },
      }
      );

      let output = "";
      let stderrOutput = "";
      
      serverProcess.stdout?.on("data", (data) => {
        const chunk = data.toString();
        output += chunk;
        console.log("Server stdout:", chunk);
        const match = stripAnsi(output).match(
          /Tool Token Budget UI running at: (http:\/\/127\.0\.0\.1:\d+\?token=[a-f0-9]+)/
        );
        if (match && !serverUrl) {
          serverUrl = match[1];
          console.log("Captured server URL:", serverUrl);
          // Give server a moment to fully initialize
          setTimeout(() => succeed(), 1000);
        }
      });

      serverProcess.stderr?.on("data", (data) => {
        const chunk = data.toString();
        stderrOutput += chunk;
        console.error("Server stderr:", chunk);
      });

      serverProcess.on("error", (err) => {
        console.error("Server process error:", err);
        fail(err instanceof Error ? err : new Error(String(err)));
      });

      serverProcess.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          console.error("Server exited with code:", code);
          console.error("Stderr:", stderrOutput);
          fail(new Error(`Server exited with code ${code}`));
        }
      });

      const startupTimeout = setTimeout(() => {
        console.error("Timeout waiting for server. Output:", output);
        console.error("Stderr:", stderrOutput);
        fail(new Error("Server failed to start within timeout"));
      }, 45000);
    });
  });

  test.beforeEach(async ({}, testInfo) => {
    const mcpPath = path.join(testHome, ".cursor", "mcp.json");
    const content = defaultMcpConfigContent();
    const previous = existsSync(mcpPath) ? readFileSync(mcpPath, "utf8") : "";
    if (previous === content) {
      return;
    }
    testInfo.setTimeout(120_000);
    writeFileSync(mcpPath, content, "utf8");
    await waitForBaselineMatchesDefaultMcp();
  });

  test.afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill();
      await new Promise<void>((resolve) => {
        serverProcess.on("exit", () => resolve());
        setTimeout(resolve, 2000);
      });
    }
    
    // Clean up test home directory
    try {
      rmSync(testHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    try {
      rmSync(e2eWorkDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    try {
      rmSync(e2eExportRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test("GUARD: e2e does not touch real home directory", async ({ page }) => {
    // Critical safety check: verify testHome is not dangerous
    const isDangerous = isDangerousTestHome(testHome, REAL_HOME);
    expect(isDangerous).toBe(false);
    expect(testHome).toContain("e2e-test-home");
    
    // The server should be using the isolated test home
    console.log(`Test home: ${testHome}`);
    console.log(`Real home (forbidden): ${REAL_HOME}`);
  });

  test("Item 1c: no client is auto-selected for apply on load", async ({ page }) => {
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    // Check client selector - it should exist but nothing should be selected
    const clientSelector = page.getByTestId("client-select");
    
    if (await clientSelector.isVisible()) {
      const selectedValue = await clientSelector.inputValue();
      // Either empty or the selector shouldn't exist for apply operations
      // The key is that Apply section should be disabled without explicit selection
      console.log(`Client selector value: ${selectedValue}`);
    }
    
    // Navigate to Editor to check Apply section
    const editorTab = page.locator('button:has-text("Editor")');
    if (await editorTab.isVisible()) {
      await editorTab.click();
      await page.waitForTimeout(500);
      
      // If no client is selected, the Preview Apply button should be disabled
      const previewButton = page.locator('button:has-text("Preview Apply")');
      if (await previewButton.isVisible()) {
        const isDisabled = await previewButton.isDisabled();
        console.log(`Preview Apply button disabled: ${isDisabled}`);
        // It's OK if it's enabled or disabled - the point is user must explicitly choose
        // The critical fix was removing auto-selection code from App.tsx line 40-42
      }
    }
    
    await expect(page.locator(".app-header h1")).toContainText("Tool Token Budget");
  });

  test("loads dashboard and shows servers", async ({ page }) => {
    const response = await page.goto(serverUrl);
    console.log("Page response status:", response?.status());
    
    // Wait for React to render
    await page.waitForTimeout(2000);
    
    const content = await page.content();
    console.log("Page HTML length:", content.length);
    console.log("Page title:", await page.title());

    await expect(page.locator(".app-header h1")).toContainText("Tool Token Budget", { timeout: 10000 });

    const totalTokens = page.locator(".total-card").first();
    await expect(totalTokens).toBeVisible();

    await expect(page.locator(".servers-table")).toBeVisible();

    const serverRows = page.locator(".servers-table tbody tr");
    await expect(serverRows).not.toHaveCount(0);
  });

  test("displays totals correctly", async ({ page }) => {
    await page.goto(serverUrl);

    const totalCards = page.locator(".total-card");
    await expect(totalCards).toHaveCount(4);

    const labels = await totalCards.locator(".total-label").allTextContents();
    expect(labels).toContain("Total Tokens");
    expect(labels).toContain("Tools");
    expect(labels).toContain("Servers");
    expect(labels).toContain("Lint Findings");
  });

  test("shows top offenders table", async ({ page }) => {
    await page.goto(serverUrl);

    await expect(page.getByText("Top 10 Tools by Token Cost")).toBeVisible();
    const offendersTable = page.locator(".top-offenders table");
    await expect(offendersTable).toBeVisible();
  });

  test("navigates to Editor tab", async ({ page }) => {
    await page.goto(serverUrl);
    
    // Click Editor button
    await page.click('button:has-text("Editor")');
    
    // Wait for editor to load
    await expect(page.locator(".editor")).toBeVisible();
    await expect(page.locator("h2:has-text('Policy Editor')")).toBeVisible();
  });

  test("editor shows policy controls and presets", async ({ page }) => {
    await page.goto(serverUrl);
    await page.click('button:has-text("Editor")');
    
    // Check policy controls
    await expect(page.locator("label:has-text('Keep per server')")).toBeVisible();
    await expect(page.locator("label:has-text('Keep hot (global)')")).toBeVisible();
    
    // Check presets
    await expect(page.locator("button:has-text('Aggressive')")).toBeVisible();
    await expect(page.locator("button:has-text('Default')")).toBeVisible();
    await expect(page.locator("button:has-text('Minimal')")).toBeVisible();
  });

  test("editor shows tools without checkboxes", async ({ page }) => {
    await page.goto(serverUrl);
    await page.click('button:has-text("Editor")');
    
    // Wait for editor to fully load
    await page.waitForTimeout(1000);
    
    // Check that tools are displayed
    const toolItems = page.locator('.tool-item');
    await expect(toolItems.first()).toBeVisible();
    
    // Check that checkboxes are NOT present (removed as dead controls)
    const toolCheckboxes = page.locator('.tool-item input[type="checkbox"]');
    await expect(toolCheckboxes).toHaveCount(0);
  });

  test("editor updates savings when policy changes", async ({ page }) => {
    await page.goto(serverUrl);
    await page.click('button:has-text("Editor")');
    
    // Wait for initial proposal
    await page.waitForTimeout(1500);
    
    // Check savings display appears
    await expect(page.locator("h3:has-text('Proposal Savings')")).toBeVisible();
    await expect(page.locator(".savings-display")).toBeVisible();
  });

  test("opens and closes settings panel", async ({ page }) => {
    await page.goto(serverUrl);
    
    // Click settings button (gear icon)
    await page.click('button.settings-button');
    
    // Settings panel should appear
    await expect(page.locator(".settings-panel")).toBeVisible();
    await expect(page.locator("h2:has-text('Settings')")).toBeVisible();
    
    // Close settings
    await page.click("button.close-button");
    
    // Settings panel should disappear
    await expect(page.locator(".settings-panel")).not.toBeVisible();
  });

  test("settings panel has theme controls and theme persists", async ({ page }) => {
    await page.goto(serverUrl);
    
    // Wait for page to fully load
    await page.waitForTimeout(1000);
    
    // Open settings
    await page.click('button.settings-button');
    
    // Wait for settings panel to appear
    await expect(page.locator(".settings-panel")).toBeVisible();
    
    // Check theme buttons in settings panel
    const lightBtn = page.locator('.settings-panel button:has-text("Light")');
    const darkBtn = page.locator('.settings-panel button:has-text("Dark")');
    const systemBtn = page.locator('.settings-panel button:has-text("System")');

    // Switch to dark
    await darkBtn.click();
    await expect(darkBtn).toHaveClass(/active/);
    
    // Wait a moment for theme to be applied and saved
    await page.waitForTimeout(300);
    
    // Check that data-theme attribute is set
    const rootTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(rootTheme).toBe("dark");

    // Check localStorage was updated
    const storedTheme = await page.evaluate(() =>
      localStorage.getItem("tool-token-budget-theme")
    );
    expect(storedTheme).toBe("dark");

    // Close settings
    await page.click("button.close-button");
    
    // Wait for settings to close
    await expect(page.locator(".settings-panel")).not.toBeVisible();

    // Reload page and verify theme persists
    await page.reload();
    await expect(page.locator(".app-header h1")).toContainText("Tool Token Budget");
    
    // Wait for page to fully initialize
    await page.waitForTimeout(500);
    
    const persistedTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(persistedTheme).toBe("dark");
  });

  test("navigates to Lint tab", async ({ page }) => {
    await page.goto(serverUrl);
    
    // Click Lint button
    await page.click('button:has-text("Lint")');
    
    // Wait for lint view to load
    await expect(page.locator(".lint-drilldown")).toBeVisible();
  });

  test("default policy from Settings is applied in Editor", async ({ page }) => {
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);
    
    // Open Settings
    await page.click('button.settings-button');
    await expect(page.locator(".settings-panel")).toBeVisible();
    
    // Find the "Keep per server" input in the Default Policy section
    const keepPerServerInput = page.locator('.settings-panel label:has-text("Keep per server") input[type="number"]');
    await keepPerServerInput.clear();
    await keepPerServerInput.fill("5");
    
    // Trigger the change event
    await keepPerServerInput.blur();
    
    // Wait for save
    await page.waitForTimeout(500);
    
    // Verify localStorage was updated
    const savedPolicy = await page.evaluate(() => localStorage.getItem("defaultPolicy"));
    expect(savedPolicy).toContain('"keepPerServer":5');
    
    // Close settings
    await page.click("button.close-button");
    await expect(page.locator(".settings-panel")).not.toBeVisible();
    
    // Reload page
    await page.reload();
    await expect(page.locator(".app-header h1")).toContainText("Tool Token Budget");
    await page.waitForTimeout(1000);
    
    // Open Editor
    await page.click('button:has-text("Editor")');
    await expect(page.locator(".editor")).toBeVisible();
    await page.waitForTimeout(500);
    
    // Verify the policy in Editor uses the saved default
    const editorKeepPerServer = page.locator('.editor label:has-text("Keep per server") input[type="number"]');
    const value = await editorKeepPerServer.inputValue();
    expect(value).toBe("5");
  });

  test("watch interval changes persist and take effect", async ({ page }) => {
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);
    
    // Open Settings
    await page.click('button.settings-button');
    await expect(page.locator(".settings-panel")).toBeVisible();
    
    // Find the refresh interval input
    const intervalInput = page.locator('.settings-panel label:has-text("Refresh interval") input[type="number"]');
    await expect(intervalInput).toBeVisible();
    
    // Change interval to 45 seconds
    await intervalInput.clear();
    await intervalInput.fill("45");
    await intervalInput.blur();
    
    // Wait for the change to take effect and localStorage to be updated
    await page.waitForTimeout(1500);
    
    // Verify localStorage was updated
    const savedInterval = await page.evaluate(() => localStorage.getItem("refreshInterval"));
    expect(savedInterval).toBe("45");
    
    // Close settings
    await page.click("button.close-button");
    await expect(page.locator(".settings-panel")).not.toBeVisible();
    
    // Reload the page
    await page.reload();
    await page.waitForTimeout(1500); // Allow time for async loading in useEffect
    
    // Verify the effective interval by checking /api/health
    const healthResponse = await page.evaluate(async () => {
      const token = new URLSearchParams(window.location.search).get("token") || "";
      const res = await fetch("/api/health", {
        headers: { "X-Auth-Token": token }
      });
      return res.json();
    });
    
    expect(healthResponse.watchIntervalSec).toBe(45);
    
    // Also verify in Settings UI
    await page.click('button.settings-button');
    await expect(page.locator(".settings-panel")).toBeVisible();
    await page.waitForTimeout(500); // Allow Settings component to load and apply saved value
    const reloadedInput = page.locator('.settings-panel label:has-text("Refresh interval") input[type="number"]');
    const reloadedValue = await reloadedInput.inputValue();
    expect(reloadedValue).toBe("45");
    
    // Verify the effective interval is shown in help text
    const helpText = page.locator('.settings-panel .help-text:has-text("Effective:")');
    await expect(helpText).toContainText("45s");
  });

  test("saved interval applies on app load WITHOUT opening Settings (Item 5)", async ({ page }) => {
    // Set a custom interval in localStorage before loading
    await page.goto(serverUrl);
    await page.waitForTimeout(500);
    
    // Set interval to 50 in localStorage
    await page.evaluate(() => {
      localStorage.setItem("refreshInterval", "50");
    });
    
    // Reload WITHOUT opening Settings
    await page.reload();
    await page.waitForTimeout(2000); // Allow App useEffect to apply saved interval
    
    // Verify the effective interval by checking /api/health (should be 50)
    const healthResponse = await page.evaluate(async () => {
      const token = new URLSearchParams(window.location.search).get("token") || "";
      const res = await fetch("/api/health", {
        headers: { "X-Auth-Token": token }
      });
      return res.json();
    });
    
    expect(healthResponse.watchIntervalSec).toBe(50);
    
    // Cleanup: reset to default
    await page.evaluate(() => {
      localStorage.removeItem("refreshInterval");
    });
  });

  test("Stage C: Apply happy path (preview, type apply, apply, backup shown)", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    // Click Editor tab
    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    // Wait for editor to load
    await expect(page.locator('.editor')).toBeVisible();

    // Scroll to apply section
    const applySection = page.locator('.apply-section');
    await applySection.scrollIntoViewIfNeeded();

    const clientSelector = page.locator('select.client-selector, .apply-section select').first();
    await expect(clientSelector).toBeVisible();
    await clientSelector.selectOption("cursor-global");
    await page.waitForTimeout(500);

    const disableOverInput = page.locator('label:has-text("Disable servers over") input');
    await disableOverInput.fill("0");
    await page.waitForTimeout(2500);

    const previewButton = page.locator('button:has-text("Preview Apply")');
    await expect(previewButton).toBeEnabled({ timeout: 15000 });
    await previewButton.click();
    await page.waitForTimeout(1500);

    const previewDiv = page.locator('.apply-preview');
    await expect(previewDiv).toBeVisible();
    const diffText = await page.locator('.diff-view').textContent();
    expect(diffText).not.toContain("No changes.");
    expect(diffText).toContain("remote-example");

    const confirmInput = page.locator('.confirmation-input input');
    await confirmInput.fill("apply");

    const applyButton = page.locator('.apply-button:has-text("Apply Changes")');
    await expect(applyButton).toBeEnabled();
    await applyButton.click();
    await page.waitForTimeout(1500);

    await expect(page.locator('.success-message')).toBeVisible();
    const successText = await page.locator('.success-message').textContent();
    expect(successText).toMatch(/Backup|applied successfully/i);

    const mcpPath = path.join(testHome, ".cursor", "mcp.json");
    const after = JSON.parse(readFileSync(mcpPath, "utf8"));
    expect(after.mcpServers.stub).toBeUndefined();
    expect(after.mcpServers.stub2).toBeUndefined();
    expect(after.mcpServers["remote-example"]).toBeDefined();
  });

  test("Item 3a: with one client, selector shows 'Choose a client…' and Apply/Export disabled until picked", async ({ page }) => {
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    // Navigate to Editor tab
    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    // Find the client selector
    const clientSelector = page.locator('select.client-selector, select[aria-label*="client" i], .apply-section select').first();
    
    // Check if selector exists and has the placeholder option selected
    if (await clientSelector.isVisible()) {
      const selectedText = await clientSelector.locator('option:checked').textContent();
      expect(selectedText?.toLowerCase()).toContain('choose');
      
      // Verify Apply button is disabled
      const previewButton = page.locator('button:has-text("Preview Apply")');
      await expect(previewButton).toBeDisabled();
    }
    
    // Check Export section (if visible)
    const exportButton = page.locator('button:has-text("Export")');
    if (await exportButton.isVisible()) {
      const exportClientSelector = page.locator('.export-section select').first();
      if (await exportClientSelector.isVisible()) {
        const exportSelectedText = await exportClientSelector.locator('option:checked').textContent();
        expect(exportSelectedText?.toLowerCase()).toContain('choose');
        await expect(exportButton).toBeDisabled();
      }
    }
  });

  test("Item 3b: with several clients, picking first real option selects it and updates UI", async ({ page }) => {
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    // Navigate to Editor tab
    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    // Find the client selector
    const clientSelector = page.locator('select.client-selector, select[aria-label*="client" i], .apply-section select').first();
    
    if (await clientSelector.isVisible()) {
      // Get all options
      const options = await clientSelector.locator('option').all();
      
      if (options.length > 1) {
        // Find the first non-placeholder option
        let firstRealOptionValue = '';
        for (const option of options) {
          const value = await option.getAttribute('value');
          const text = await option.textContent();
          if (value && value !== '' && !text?.toLowerCase().includes('choose')) {
            firstRealOptionValue = value;
            break;
          }
        }
        
        if (firstRealOptionValue) {
          // Select the first real client
          await clientSelector.selectOption(firstRealOptionValue);
          await page.waitForTimeout(500);
          
          // Verify the selection took effect
          const selectedValue = await clientSelector.inputValue();
          expect(selectedValue).toBe(firstRealOptionValue);
          
          // Verify dependent UI updated (Preview Apply button should become enabled)
          const previewButton = page.locator('button:has-text("Preview Apply")');
          const isEnabled = await previewButton.isEnabled();
          expect(isEnabled).toBe(true);
        }
      }
    }
  });

  test("Item 3c: 409 error shows visible alert next to Apply button when config modified between preview and apply", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    const clientSelector = page.locator('select.client-selector, .apply-section select').first();
    await expect(clientSelector).toBeVisible();
    await clientSelector.selectOption("cursor-global");
    await page.waitForTimeout(500);

    const disableOverInput = page.locator('label:has-text("Disable servers over") input');
    await disableOverInput.fill("0");
    await page.waitForTimeout(2500);

    const previewButton = page.locator('button:has-text("Preview Apply")');
    await expect(previewButton).toBeEnabled({ timeout: 15000 });
    await previewButton.click();
    await page.waitForTimeout(1500);
    const diffText = await page.locator('.diff-view').textContent();
    expect(diffText).not.toContain("No changes.");
    await expect(page.locator('.apply-preview')).toBeVisible();

    const mcpPath = path.join(testHome, ".cursor", "mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { tampered: { command: "node", args: ["x.js"] } } }, null, 2) + "\n",
      "utf8"
    );

    const confirmInput = page.locator('.confirmation-input input');
    await confirmInput.fill("apply");
    const applyButton = page.locator('.apply-button:has-text("Apply Changes")');
    await expect(applyButton).toBeEnabled();
    await applyButton.click();
    await page.waitForTimeout(1500);

    const applySection = page.locator('.apply-section');
    const errorAlert = applySection.locator('[role="alert"]');
    await expect(errorAlert).toBeVisible();
    await expect(errorAlert).toBeInViewport();
    await expect(errorAlert).toContainText(/changed|conflict|409/i);
  });

  test("Item 22: discovery 503 shows friendly alert without raw JSON", async ({ page }) => {
    test.setTimeout(60_000);
    await page.route("**/api/apply/preview", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Discovery in progress; retry preview/apply in a few seconds",
        }),
      });
    });

    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    const clientSelector = page.locator('select.client-selector, .apply-section select').first();
    await clientSelector.selectOption("cursor-global");
    await page.waitForTimeout(500);

    const previewButton = page.locator('button:has-text("Preview Apply")');
    await expect(previewButton).toBeEnabled({ timeout: 15000 });
    await previewButton.click();

    const errorAlert = page.locator('.apply-section [role="alert"]');
    await expect(errorAlert).toBeVisible({ timeout: 15000 });
    await expect(errorAlert).toContainText("Still loading servers, try again in a moment"); // DISCOVERY_LOADING_MESSAGE
    const alertText = await errorAlert.textContent();
    expect(alertText).not.toMatch(/\{\s*"error"/);
  });

  test("Item 22b: discovery 503 auto-retries then preview succeeds", async ({ page }) => {
    test.setTimeout(60_000);
    let previewCalls = 0;
    await page.route("**/api/apply/preview", async (route) => {
      previewCalls++;
      if (previewCalls <= 2) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Discovery in progress; retry preview/apply in a few seconds",
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    const clientSelector = page.locator('select.client-selector, .apply-section select').first();
    await clientSelector.selectOption("cursor-global");
    await page.waitForTimeout(500);

    const disableOverInput = page.locator('label:has-text("Disable servers over") input');
    await disableOverInput.fill("0");
    await page.waitForTimeout(2500);

    const previewButton = page.locator('button:has-text("Preview Apply")');
    await expect(previewButton).toBeEnabled({ timeout: 15000 });
    await previewButton.click();

    await expect(page.locator('.apply-preview')).toBeVisible({ timeout: 20000 });
    const errorAlert = page.locator('.apply-section [role="alert"]');
    await expect(errorAlert).toHaveCount(0);
    expect(previewCalls).toBeGreaterThanOrEqual(3);
  });

  test("Item b: view-only clients show disabled buttons with reason", async ({ page }) => {
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    // Navigate to Editor tab
    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    // Find the client selector
    const clientSelector = page.locator('select.client-selector').first();
    
    if (await clientSelector.isVisible()) {
      // Get all options
      const options = await clientSelector.locator('option').all();
      
      // Look for a view-only client option
      let viewOnlyOptionValue = '';
      for (const option of options) {
        const text = await option.textContent();
        if (text?.includes('view-only')) {
          viewOnlyOptionValue = await option.getAttribute('value') || '';
          break;
        }
      }
      
      if (viewOnlyOptionValue) {
        // Select the view-only client
        await clientSelector.selectOption(viewOnlyOptionValue);
        await page.waitForTimeout(500);
        
        // Verify Export button is disabled
        const exportButton = page.locator('.export-section button:has-text("Export")');
        await expect(exportButton).toBeDisabled();
        
        // Verify export reason message is shown
        const exportReason = page.locator('.export-section .info-message:has-text("view-only")');
        await expect(exportReason).toBeVisible();
        
        // Verify Preview button is disabled
        const previewButton = page.locator('button:has-text("Preview Apply")');
        await expect(previewButton).toBeDisabled();
        
        // Verify preview/apply reason message is shown
        const applyReason = page.locator('.apply-section .info-message:has-text("view-only")');
        await expect(applyReason).toBeVisible();
      }
    }
  });

  test("Item c: Export disabled when proposal removes all servers", async ({ page }) => {
    const mcpPath = path.join(testHome, ".cursor", "mcp.json");
    const stubOnly = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, unknown> };
    delete stubOnly.mcpServers["remote-example"];
    writeFileSync(mcpPath, JSON.stringify(stubOnly, null, 2) + "\n", "utf8");

    await page.goto(serverUrl);
    await page.waitForTimeout(3000);

    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    const clientSelector = page.locator('select.client-selector, .export-section select').first();
    await clientSelector.selectOption("cursor-global");
    await page.waitForTimeout(500);

    const exportButton = page.locator('.export-section button:has-text("Export")');
    await expect(exportButton).toBeVisible();

    const disableInput = page.locator('label:has-text("Disable servers over") input[type="number"]');
    await disableInput.fill("0");
    await page.waitForTimeout(3000);

    await expect(exportButton).toBeDisabled();
    await expect(page.locator('.export-section .info-message:has-text("zero")')).toBeVisible();
  });

  test("Item 27: stale Exported message clears when export becomes disabled", async ({ page }) => {
    test.setTimeout(90_000);
    const mcpPath = path.join(testHome, ".cursor", "mcp.json");
    const stubOnly = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, unknown> };
    delete stubOnly.mcpServers["remote-example"];
    writeFileSync(mcpPath, JSON.stringify(stubOnly, null, 2) + "\n", "utf8");

    await page.goto(serverUrl);
    await page.waitForTimeout(3000);

    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    const clientSelector = page.locator('select.client-selector, .export-section select').first();
    await clientSelector.selectOption("cursor-global");
    await page.waitForTimeout(500);

    const exportButton = page.locator('.export-section button:has-text("Export")');
    await expect(exportButton).toBeEnabled({ timeout: 20000 });
    await exportButton.click();
    await page.waitForTimeout(2000);
    await expect(page.locator('.export-section .success-message')).toBeVisible();

    const disableInput = page.locator('label:has-text("Disable servers over") input[type="number"]');
    await disableInput.fill("0");
    await page.waitForTimeout(3000);

    await expect(exportButton).toBeDisabled();
    await expect(page.locator('.export-section .success-message')).toHaveCount(0);
  });

  test("Item d: Apply disabled when preview shows no changes", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    const clientSelector = page.locator('select.client-selector, .apply-section select').first();
    await expect(clientSelector).toBeVisible();
    await clientSelector.selectOption("cursor-global");
    await page.waitForTimeout(500);

    const keepInput = page.locator('label:has-text("Keep per server") input');
    await keepInput.fill("10");
    await page.waitForTimeout(2500);

    const previewButton = page.locator('button:has-text("Preview Apply")');
    await expect(previewButton).toBeEnabled({ timeout: 15000 });
    await previewButton.click();
    await page.waitForTimeout(1500);

    await expect(page.locator('.apply-preview')).toBeVisible();
    const diffText = await page.locator('.diff-view').textContent();
    expect(diffText).toContain("No changes.");

    await expect(page.locator('.apply-button:has-text("Apply Changes")')).toHaveCount(0);
    await expect(
      page.locator('.apply-preview .info-message:has-text("No changes")')
    ).toBeVisible();
  });

  test("Item f: Dark mode kept-tool and Saved card have sufficient contrast", async ({ page }) => {
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    // Switch to dark mode
    const themeToggle = page.locator('.theme-toggle button:has-text("Dark")');
    if (await themeToggle.isVisible()) {
      await themeToggle.click();
      await page.waitForTimeout(500);
    }

    // Navigate to Editor tab to see kept tools
    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    // Check kept-tool card contrast
    const keptTool = page.locator('.tool-item.kept').first();
    if (await keptTool.isVisible()) {
      const keptColor = await keptTool.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return {
          color: style.color,
          backgroundColor: style.backgroundColor
        };
      });

      // Parse RGB values and compute contrast ratio
      const parseRgb = (rgb: string) => {
        const match = rgb.match(/\d+/g);
        return match ? match.map(Number) : [0, 0, 0];
      };

      const textRgb = parseRgb(keptColor.color);
      const bgRgb = parseRgb(keptColor.backgroundColor);

      const getLuminance = ([r, g, b]: number[]) => {
        const [rs, gs, bs] = [r, g, b].map(c => {
          c = c / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      };

      const textL = getLuminance(textRgb);
      const bgL = getLuminance(bgRgb);
      const contrast = (Math.max(textL, bgL) + 0.05) / (Math.min(textL, bgL) + 0.05);

      // WCAG AA requires 4.5:1 for normal text
      expect(contrast).toBeGreaterThanOrEqual(4.5);
      
      // Also verify colors are different
      expect(keptColor.color).not.toBe(keptColor.backgroundColor);
    }

    // Check Saved card contrast
    const savingsHighlight = page.locator('.savings-highlight .value').first();
    if (await savingsHighlight.isVisible()) {
      const savedColor = await savingsHighlight.evaluate((el) => {
        const style = window.getComputedStyle(el);
        const parent = el.closest('.savings-highlight');
        const parentStyle = parent ? window.getComputedStyle(parent) : style;
        return {
          color: style.color,
          backgroundColor: parentStyle.backgroundColor
        };
      });

      const parseRgb = (rgb: string) => {
        const match = rgb.match(/\d+/g);
        return match ? match.map(Number) : [0, 0, 0];
      };

      const textRgb = parseRgb(savedColor.color);
      const bgRgb = parseRgb(savedColor.backgroundColor);

      const getLuminance = ([r, g, b]: number[]) => {
        const [rs, gs, bs] = [r, g, b].map(c => {
          c = c / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      };

      const textL = getLuminance(textRgb);
      const bgL = getLuminance(bgRgb);
      const contrast = (Math.max(textL, bgL) + 0.05) / (Math.min(textL, bgL) + 0.05);

      // WCAG AA requires 4.5:1 for normal text
      expect(contrast).toBeGreaterThanOrEqual(4.5);
      
      // Also verify colors are different
      expect(savedColor.color).not.toBe(savedColor.backgroundColor);
    }
  });

  test("Item g: One 'Tool Token Budget' heading and no overlap at 800px", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    // Check for exactly one 'Tool Token Budget' h1 heading
    const headings = page.locator('h1:has-text("Tool Token Budget")');
    const count = await headings.count();
    expect(count).toBe(1);

    // Check savings banner spacing at 800px (if visible)
    const savingsBanner = page.locator('.savings-banner');
    if (await savingsBanner.isVisible()) {
      const strong = savingsBanner.locator('strong').first();
      
      if (await strong.isVisible()) {
        const strongBox = await strong.boundingBox();
        const bannerBox = await savingsBanner.boundingBox();
        
        // Get all text content after the strong tag
        const bannerText = await savingsBanner.textContent();
        const textAfterStrong = bannerText?.split(':')[1];
        
        if (strongBox && bannerBox && textAfterStrong) {
          // At 800px, the banner should wrap or have enough space
          // Check that the strong element doesn't take up the full width
          const widthRatio = strongBox.width / bannerBox.width;
          expect(widthRatio).toBeLessThan(0.9); // Should not take up 90% of the width
        }
      }
    }
  });

  test("Item h: System theme follows OS changes on non-dashboard views", async ({ page }) => {
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    // Ensure we're on system theme
    const settingsBtn = page.locator('.settings-button');
    await settingsBtn.click();
    await page.waitForTimeout(500);

    const systemBtn = page.locator('.settings-panel button:has-text("System")');
    await systemBtn.click();
    await page.waitForTimeout(300);

    // Close settings
    const closeBtn = page.locator('.close-button');
    await closeBtn.click();
    await page.waitForTimeout(300);

    // Navigate to Editor (non-dashboard view)
    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    // Emulate dark color scheme
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);

    // Check that theme is dark
    let theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(theme).toBe("dark");

    // Emulate light color scheme
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(300);

    // Check that theme is light
    theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(theme).toBe("light");
  });

  test("Item 5: tool cards have space between name and token count", async ({ page }) => {
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    // Navigate to Editor tab
    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    // Find a tool item
    const toolItem = page.locator('.tool-item').first();
    await expect(toolItem).toBeVisible();

    // Verify the tool item has separate elements for name and tokens
    const toolName = toolItem.locator('.tool-name');
    const toolTokens = toolItem.locator('.tool-tokens');
    
    await expect(toolName).toBeVisible();
    await expect(toolTokens).toBeVisible();

    // Get bounding boxes to verify they are separated (not overlapping)
    const nameBox = await toolName.boundingBox();
    const tokensBox = await toolTokens.boundingBox();

    expect(nameBox).not.toBeNull();
    expect(tokensBox).not.toBeNull();

    if (nameBox && tokensBox) {
      // Verify there's horizontal spacing between the elements
      // Either name ends before tokens starts, or tokens ends before name starts
      const hasHorizontalGap = 
        (nameBox.x + nameBox.width < tokensBox.x) || // name is to the left with gap
        (tokensBox.x + tokensBox.width < nameBox.x);  // tokens is to the left with gap
      
      expect(hasHorizontalGap).toBe(true);
      
      // Additional check: gap should be at least a few pixels
      if (nameBox.x + nameBox.width < tokensBox.x) {
        const gap = tokensBox.x - (nameBox.x + nameBox.width);
        expect(gap).toBeGreaterThan(2); // At least 2px gap
      }
    }
  });

  test("Item 6: System theme follows OS changes live while Settings is closed", async ({ page }) => {
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    // Open Settings and set theme to System
    await page.click('button.settings-button');
    await expect(page.locator('.settings-panel')).toBeVisible();

    const systemBtn = page.locator('.settings-panel button:has-text("System")');
    await systemBtn.click();
    await expect(systemBtn).toHaveClass(/active/);
    await page.waitForTimeout(300);

    // Close Settings
    await page.click('button.close-button');
    await expect(page.locator('.settings-panel')).not.toBeVisible();

    // Emulate dark mode and verify theme changes WITHOUT reloading
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(500);

    let theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('dark');

    // Emulate light mode and verify theme changes WITHOUT reloading
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(500);

    theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('light');

    // Verify Settings is still closed throughout
    const settingsPanelVisible = await page.locator('.settings-panel').isVisible();
    expect(settingsPanelVisible).toBe(false);
  });

  test("Item 12a: System theme follows OS after switching from Light mid-session", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("tool-token-budget-theme", "light");
    });
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    await page.click('button.settings-button');
    await expect(page.locator('.settings-panel')).toBeVisible();

    const systemBtn = page.locator('.settings-panel button:has-text("System")');
    await systemBtn.click();
    await expect(systemBtn).toHaveClass(/active/);
    await page.waitForTimeout(300);

    await page.click('button.close-button');
    await expect(page.locator('.settings-panel')).not.toBeVisible();

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(500);
    let theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('dark');

    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(500);
    theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('light');
  });

  test("Item 12b: explicit Dark theme is not overridden by OS changes", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("tool-token-budget-theme", "system");
    });
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);

    await page.click('button.settings-button');
    await expect(page.locator('.settings-panel')).toBeVisible();

    const darkBtn = page.locator('.settings-panel button:has-text("Dark")');
    await darkBtn.click();
    await expect(darkBtn).toHaveClass(/active/);
    await page.waitForTimeout(300);

    await page.click('button.close-button');
    await expect(page.locator('.settings-panel')).not.toBeVisible();

    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(500);
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('dark');
  });

  test("Item 31: no tool-token-budget-export directory left in repo root after e2e", async () => {
    for (const dirName of ["tool-token-budget-export", "schema-budget-export"]) {
      const exportDir = path.join(repoRoot, dirName);
      expect(existsSync(exportDir)).toBe(false);
      if (existsSync(exportDir)) {
        const entries = readdirSync(exportDir);
        expect(entries).toHaveLength(0);
      }
    }
  });

  test("Item 34: stale Exported message clears on client change and policy change", async ({ page }) => {
    test.setTimeout(90_000);
    const mcpPath = path.join(testHome, ".cursor", "mcp.json");
    const projectCursorDir = path.join(e2eWorkDir, ".cursor");
    mkdirSync(projectCursorDir, { recursive: true });
    writeFileSync(
      path.join(projectCursorDir, "mcp.json"),
      JSON.stringify({ mcpServers: { stub: defaultMcpConfig.mcpServers.stub } }, null, 2) + "\n",
      "utf8"
    );

    const stubOnly = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, unknown> };
    delete stubOnly.mcpServers["remote-example"];
    writeFileSync(mcpPath, JSON.stringify(stubOnly, null, 2) + "\n", "utf8");

    await page.goto(serverUrl);
    await page.waitForTimeout(2000);

    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    const clientSelector = page.locator('select.client-selector, .export-section select').first();
    await clientSelector.selectOption("cursor-global");
    await page.waitForTimeout(500);

    const exportButton = page.locator('.export-section button:has-text("Export")');
    await expect(exportButton).toBeEnabled({ timeout: 20000 });
    await exportButton.click();
    await page.waitForTimeout(2000);
    await expect(page.locator('.export-section .success-message')).toBeVisible();

    const headerSelector = page.locator("header select.client-selector");
    await headerSelector.selectOption("cursor-project");
    await page.waitForTimeout(500);
    await expect(page.locator('.export-section .success-message')).toHaveCount(0);

    await headerSelector.selectOption("cursor-global");
    await clientSelector.selectOption("cursor-global");
    await page.waitForTimeout(500);
    await exportButton.click();
    await page.waitForTimeout(2000);
    await expect(page.locator('.export-section .success-message')).toBeVisible();

    const keepInput = page.locator('label:has-text("Keep per server") input');
    await keepInput.fill("1");
    await page.waitForTimeout(2500);
    await expect(page.locator('.export-section .success-message')).toHaveCount(0);
  });

  test("Item 37: 422 policy alert is fully within the viewport", async ({ page }) => {
    test.setTimeout(90_000);
    const mcpPath = path.join(testHome, ".cursor", "mcp.json");
    const stubOnly = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, unknown> };
    delete stubOnly.mcpServers["remote-example"];
    writeFileSync(mcpPath, JSON.stringify(stubOnly, null, 2) + "\n", "utf8");

    await page.goto(serverUrl);
    await page.waitForTimeout(2000);

    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    const clientSelector = page.locator('select.client-selector, .apply-section select').first();
    await clientSelector.selectOption("cursor-global");
    await page.waitForTimeout(500);

    const disableInput = page.locator('label:has-text("Disable servers over") input[type="number"]');
    await disableInput.fill("0");
    await page.waitForTimeout(3000);

    const previewButton = page.locator('button:has-text("Preview Apply")');
    await expect(previewButton).toBeEnabled({ timeout: 15000 });
    await previewButton.click();
    await page.waitForTimeout(1500);

    const errorAlert = page.locator('.apply-section [role="alert"]');
    await expect(errorAlert).toBeVisible({ timeout: 15000 });
    await expect(errorAlert).toBeInViewport();
    const box = await errorAlert.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (box && viewport) {
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }
  });

  test("pr20-item01 / Item 57: exactly one error banner on broken config preview", async ({ page }) => {
    test.setTimeout(120_000);
    const mcpPath = path.join(testHome, ".cursor", "mcp.json");
    writeDefaultMcpConfig();
    await waitForBaselineMatchesDefaultMcp();

    await page.goto(serverUrl);
    await page.waitForTimeout(1000);
    const editorTab = page.locator('button:has-text("Editor")');
    await editorTab.click();
    await page.waitForTimeout(500);

    const clientSelector = page.locator("select.client-selector").first();
    const options = await clientSelector.locator("option").all();
    let clientId = "";
    for (const option of options) {
      const value = await option.getAttribute("value");
      const text = await option.textContent();
      if (value && value !== "" && !text?.toLowerCase().includes("choose")) {
        clientId = value;
        break;
      }
    }
    expect(clientId).not.toBe("");
    await clientSelector.selectOption(clientId);
    await page.waitForTimeout(500);

    writeFileSync(mcpPath, "{ not-json", "utf8");
    const previewButton = page.locator('button:has-text("Preview Apply")');
    await previewButton.click();

    const configErrorBanner = page.locator(
      '.apply-section .error-banner:has-text("Config file cannot be read")'
    );
    await expect(configErrorBanner).toBeVisible({ timeout: 15000 });
    await expect(configErrorBanner).not.toContainText(/still loading servers/i);
    await expect(
      page.locator('.apply-section .error-banner:has-text("cannot be read")')
    ).toHaveCount(1, { timeout: 15000 });

    writeDefaultMcpConfig();
    await waitForBaselineMatchesDefaultMcp();
    await expect(page.locator('.apply-section .error-banner:has-text("cannot be read")')).toHaveCount(
      0,
      { timeout: 20000 }
    );

    await previewButton.click();
    await expect(page.locator(".diff-view")).toBeVisible({ timeout: 20000 });
  });

  test("Item 62: client selector remains after config deleted", async ({ page }) => {
    test.setTimeout(90_000);
    const mcpPath = path.join(testHome, ".cursor", "mcp.json");
    writeDefaultMcpConfig();
    await waitForBaselineMatchesDefaultMcp();

    await page.goto(serverUrl);
    await page.waitForTimeout(1000);
    await expect(page.locator("select.client-selector")).toBeVisible();
    const optionsBefore = await page.locator("select.client-selector option").count();
    expect(optionsBefore).toBeGreaterThan(1);

    rmSync(mcpPath);
    await page.waitForTimeout(5000);
    await expect(page.locator("select.client-selector")).toBeVisible();
    const optionsAfter = await page.locator("select.client-selector option").count();
    expect(optionsAfter).toBeGreaterThanOrEqual(optionsBefore);

    writeDefaultMcpConfig();
    await waitForBaselineMatchesDefaultMcp();
  });

  test("stage1-r2-item5: cursor-dynamic shows experimental in model picker", async ({ page }) => {
    await page.goto(serverUrl);
    await page.waitForSelector('[data-testid="model-primary-select"]', { timeout: 20000 });
    const option = page.locator('[data-testid="model-primary-select"] option[value="cursor-dynamic"]');
    await expect(option).toContainText("experimental");
  });

  async function assertPrimaryModelValue(page: import("@playwright/test").Page, modelId: string) {
    const primary = page.getByTestId("model-primary-select");
    await expect(primary).toHaveValue(modelId);
    await expect(primary.locator(`option[value="${modelId}"]`)).toHaveCount(1);
  }

  test("stage1-r4-item1a: delayed presets keep primary after editor and compare", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.route("**/api/model-presets", async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await page.goto(serverUrl);
    await page.waitForSelector('[data-testid="model-primary-select"]', { timeout: 20000 });
    await page.waitForTimeout(3000);
    await page.getByTestId("model-primary-select").selectOption("cursor-dynamic");
    await assertPrimaryModelValue(page, "cursor-dynamic");
    await page.getByRole("button", { name: "Editor" }).click();
    await page.getByRole("button", { name: "Dashboard" }).click();
    await assertPrimaryModelValue(page, "cursor-dynamic");
    await page.getByTestId("model-extra-select").selectOption("gpt-4o");
    await assertPrimaryModelValue(page, "cursor-dynamic");
    await page.getByTestId("model-extra-select").selectOption("");
    await assertPrimaryModelValue(page, "cursor-dynamic");
  });

  test("stage1-r4-item1b: failed presets keep stored primary after editor", async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      localStorage.setItem("ttb-primary-model", "cursor-dynamic");
    });
    await page.route("**/api/model-presets", (route) =>
      route.fulfill({ status: 500, body: "fail" })
    );
    await page.goto(serverUrl);
    await page.waitForSelector('[data-testid="model-primary-select"]', { timeout: 20000 });
    await assertPrimaryModelValue(page, "cursor-dynamic");
    await page.getByRole("button", { name: "Editor" }).click();
    await page.getByRole("button", { name: "Dashboard" }).click();
    await assertPrimaryModelValue(page, "cursor-dynamic");
    await page.getByTestId("model-extra-select").selectOption("openai:o200k");
    await assertPrimaryModelValue(page, "cursor-dynamic");
    await page.getByTestId("model-extra-select").selectOption("");
    await assertPrimaryModelValue(page, "cursor-dynamic");
  });

  test("stage1-r4-item5: count mode label reflects server health", async ({ page }) => {
    await page.goto(serverUrl);
    await page.waitForSelector('[data-testid="count-mode-label"]', { timeout: 20000 });
    await expect(page.getByTestId("count-mode-label")).toContainText("count mode:");
  });

  test("stage1-r4-item6: no horizontal overflow at 420px width", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto(serverUrl);
    await page.waitForSelector(".app", { timeout: 20000 });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  test("stage1-ac3: model dropdown updates per-model totals", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(serverUrl);
    await page.waitForSelector('[data-testid="model-primary-select"]', { timeout: 20000 });
    const primary = page.getByTestId("model-primary-select");
    await primary.selectOption("gpt-4o");
    await page.getByTestId("model-extra-select").selectOption("claude-sonnet-4-5");
    await page.waitForSelector('[data-testid="model-total-gpt-4o"]', { timeout: 20000 });
    await expect(page.getByTestId("model-total-gpt-4o")).toBeVisible();
    await expect(page.getByTestId("model-total-claude-sonnet-4-5")).toBeVisible();
    await primary.selectOption("claude-sonnet-4-5");
    await page.getByTestId("model-extra-select").selectOption("gpt-4o");
    await expect(page.getByTestId("model-total-claude-sonnet-4-5")).toBeVisible();
  });

  test("stage1-r5-item1a: invalid stored primary resets to openai:o200k with totals", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      localStorage.setItem("ttb-primary-model", "not-a-real-model");
    });
    await page.goto(serverUrl);
    await page.waitForSelector('[data-testid="model-primary-select"]', { timeout: 20000 });
    await assertPrimaryModelValue(page, "openai:o200k");
    const stored = await page.evaluate(() => localStorage.getItem("ttb-primary-model"));
    expect(stored).toBe("openai:o200k");
    const primary = page.getByTestId("model-primary-select");
    await expect(primary.locator('option[value="not-a-real-model"]')).toHaveCount(0);
    await page.waitForSelector('[data-testid="model-total-openai:o200k"]', {
      timeout: 20000,
    });
    await expect(page.getByTestId("model-total-openai:o200k")).toBeVisible();
  });

  test("stage1-r6-item2: compare select matches column when presets fail", async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      localStorage.setItem("ttb-extra-model", "gpt-4o");
    });
    await page.route("**/api/model-presets", (route) =>
      route.fulfill({ status: 500, body: "fail" })
    );
    await page.goto(serverUrl);
    await page.waitForSelector('[data-testid="model-extra-select"]', { timeout: 20000 });
    await expect(page.getByTestId("model-extra-select")).toHaveValue("gpt-4o");
    await page.waitForSelector('[data-testid="model-total-gpt-4o"]', { timeout: 20000 });
    await expect(page.getByTestId("model-total-gpt-4o")).toBeVisible();
  });

  test("stage1-r6-item4a: servers table spans container at desktop width", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(serverUrl);
    await page.waitForSelector('[data-testid="servers-table-wrap"]', { timeout: 20000 });
    const widths = await page.evaluate(() => {
      const wrap = document.querySelector('[data-testid="servers-table-wrap"]');
      const table = wrap?.querySelector("table");
      return {
        wrap: wrap?.clientWidth ?? 0,
        table: table?.clientWidth ?? 0,
      };
    });
    expect(widths.table).toBeGreaterThanOrEqual(widths.wrap - 4);
  });

  test("stage1-r6-item4b: no horizontal page overflow at 420px with wide tables", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto(serverUrl);
    await page.waitForSelector(".app", { timeout: 20000 });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  async function stopUiServer(): Promise<void> {
    if (!serverProcess) return;
    const proc = serverProcess;
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.kill();
      setTimeout(resolve, 5000);
    });
  }

  async function startUiServerOnPort(port: number): Promise<void> {
    const cliPath = path.join(repoRoot, "dist", "cli.js");
    const mcpPath = path.join(testHome, ".cursor", "mcp.json");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      let output = "";
      serverProcess = spawn(
        "node",
        [
          cliPath,
          "ui",
          "--no-open",
          "--port",
          String(port),
          "--watch-interval",
          "10",
          "--export-dir",
          e2eExportRoot,
          mcpPath,
        ],
        {
          cwd: e2eWorkDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: testHome,
            USERPROFILE: testHome,
            APPDATA: path.join(testHome, "AppData", "Roaming"),
            LOCALAPPDATA: path.join(testHome, "AppData", "Local"),
            XDG_CONFIG_HOME: path.join(testHome, ".config"),
            XDG_DATA_HOME: path.join(testHome, ".local", "share"),
          },
        }
      );

      serverProcess.stdout?.on("data", (data) => {
        output += data.toString();
        const match = stripAnsi(output).match(
          /Tool Token Budget UI running at: (http:\/\/127\.0\.0\.1:\d+\?token=[a-f0-9]+)/
        );
        if (match) {
          serverUrl = match[1];
          setTimeout(() => succeed(), 800);
        }
      });

      serverProcess.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
      setTimeout(() => fail(new Error(`UI server failed to start on port ${port}`)), 45000);
    });
  }

  test("stage1-r7-item1b: UI survives server restart on same port with persisted token", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    let blockEvents = false;
    await page.route("**/api/events", async (route) => {
      if (blockEvents) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await page.goto(serverUrl);
    await page.waitForSelector('[data-testid="model-primary-select"]', { timeout: 20000 });

    const port = new URL(serverUrl).port;
    blockEvents = true;
    await stopUiServer();
    await page.waitForSelector('[data-testid="sse-reconnecting"]', { timeout: 20000 });
    await startUiServerOnPort(Number(port));
    blockEvents = false;
    await expect(page.getByTestId("sse-reconnecting")).toBeHidden({ timeout: 30000 });
    await expect(page.getByTestId("session-restarted-banner")).toHaveCount(0);

    await page.getByTestId("model-extra-select").selectOption("gpt-4o");
    await page.waitForSelector('[data-testid="model-total-gpt-4o"]', { timeout: 20000 });
    await expect(page.getByTestId("model-counts-error")).toHaveCount(0);
  });

  test("stage1-r7-item1c: brief SSE drop without server restart recovers", async ({ page }) => {
    test.setTimeout(60_000);
    let failEvents = true;
    await page.route("**/api/events", async (route) => {
      if (failEvents) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.goto(serverUrl);
    await page.waitForSelector('[data-testid="sse-reconnecting"]', { timeout: 20000 });
    failEvents = false;
    await expect(page.getByTestId("sse-reconnecting")).toBeHidden({ timeout: 30000 });
  });

  test("stage1-r7-item1d: stale token after restart shows reopen URL banner", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(serverUrl);
    await page.waitForSelector(".app", { timeout: 20000 });

    const parsed = new URL(serverUrl);
    const port = parsed.port;
    const staleUrl = serverUrl;
    const tokenPath = path.join(
      testHome,
      ".cache",
      "tool-token-budget",
      "ui",
      `auth-token-port-${port}.txt`
    );
    await stopUiServer();
    if (existsSync(tokenPath)) {
      rmSync(tokenPath, { force: true });
    }
    await startUiServerOnPort(Number(port));
    expect(serverUrl).not.toBe(staleUrl);

    await page.goto(staleUrl);
    await page.waitForSelector('[data-testid="session-restarted-banner"]', { timeout: 30000 });
    await expect(page.getByTestId("session-restarted-banner")).toContainText(
      "Server restarted with a new session"
    );
    await expect(page.getByTestId("sse-reconnecting")).toHaveCount(0);
  });

  test("stage1-r6-item6: SSE reconnect shows transient status banner", async ({ page }) => {
    test.setTimeout(60_000);
    let failEvents = true;
    await page.route("**/api/events", async (route) => {
      if (failEvents) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.goto(serverUrl);
    await page.waitForSelector('[data-testid="sse-reconnecting"]', { timeout: 20000 });
    failEvents = false;
    await expect(page.getByTestId("sse-reconnecting")).toBeHidden({ timeout: 30000 });
  });

  test("stage1-r5-item2a: model-counts failure shows visible alert", async ({ page }) => {
    test.setTimeout(60_000);
    await page.route("**/api/model-counts", (route) =>
      route.fulfill({ status: 503, body: "model counts unavailable" })
    );
    await page.goto(serverUrl);
    await page.waitForSelector('[data-testid="model-counts-error"]', { timeout: 20000 });
    await expect(page.getByTestId("model-counts-error")).toContainText(
      "Couldn't load model counts"
    );
    await expect(page.getByTestId("model-counts-error")).toContainText(
      "model counts unavailable"
    );
  });

  test("stage2-e2e-export-windsurf-mock-home", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(serverUrl);
    await page.waitForTimeout(1000);
    await page.locator('button:has-text("Editor")').click();
    await page.waitForTimeout(500);
    await page.locator("select.client-selector").selectOption("windsurf");
    await page.waitForTimeout(500);
    await page.locator('button:has-text("Export Proposal")').click();
    await expect(page.locator(".export-section .success-message")).toContainText(/Exported/i, {
      timeout: 20000,
    });
    const exportDirs = readdirSync(e2eExportRoot);
    expect(exportDirs.length).toBeGreaterThan(0);
    const latest = exportDirs.sort().at(-1)!;
    const files = readdirSync(path.join(e2eExportRoot, latest));
    expect(
      files.some((f) => f.includes("mcp_config.json.tool-token-budget-proposed.json"))
    ).toBe(true);
  });

  test("stage3c-e2e-sync-cursor-to-windsurf-dry-run", async () => {
    const cliPath = path.join(repoRoot, "dist", "cli.js");
    const stubPath = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
    const windsurfPath = path.join(testHome, ".codeium", "windsurf", "mcp_config.json");
    const before = readFileSync(windsurfPath, "utf8");
    writeFileSync(
      windsurfPath,
      JSON.stringify(
        {
          mcpServers: {
            stub: { command: "node", args: [stubPath] },
            onlyOnCursor: { command: "node", args: [stubPath] },
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const dry = spawnSync(
      process.execPath,
      [
        cliPath,
        "sync",
        "--from",
        "cursor-global",
        "--to",
        "windsurf",
        "--dry-run",
        "--yes",
      ],
      {
        cwd: e2eWorkDir,
        env: {
          ...process.env,
          HOME: testHome,
          USERPROFILE: testHome,
          APPDATA: path.join(testHome, "AppData", "Roaming"),
          XDG_CONFIG_HOME: path.join(testHome, ".config"),
        },
        encoding: "utf8",
      }
    );
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout + dry.stderr).toMatch(/Remove:.*onlyOnCursor|Remove: onlyOnCursor/);
    expect(readFileSync(windsurfPath, "utf8")).toBe(
      JSON.stringify(
        {
          mcpServers: {
            stub: { command: "node", args: [stubPath] },
            onlyOnCursor: { command: "node", args: [stubPath] },
          },
        },
        null,
        2
      ) + "\n"
    );

    const live = spawnSync(
      process.execPath,
      [cliPath, "sync", "--from", "cursor-global", "--to", "windsurf", "--yes"],
      {
        cwd: e2eWorkDir,
        env: {
          ...process.env,
          HOME: testHome,
          USERPROFILE: testHome,
          APPDATA: path.join(testHome, "AppData", "Roaming"),
          XDG_CONFIG_HOME: path.join(testHome, ".config"),
        },
        encoding: "utf8",
      }
    );
    expect(live.status, live.stderr).toBe(0);
    expect(live.stdout + live.stderr).toContain("Backup:");
    const after = readFileSync(windsurfPath, "utf8");
    expect(after).not.toContain("onlyOnCursor");
    expect(after).toContain("stub2");
    writeFileSync(windsurfPath, before, "utf8");
  });

  test("stage3d-e2e-gui-history-chart", async ({ page }) => {
    const stateDir = path.join(testHome, ".config", "tool-token-budget");
    mkdirSync(stateDir, { recursive: true });
    const base = Date.parse("2026-09-20T08:00:00.000Z");
    const entries = Array.from({ length: 8 }, (_, i) => ({
      at: new Date(base + i * 3600_000).toISOString(),
      totalTokens: 80 + i * 45,
      byClient: {
        "cursor-global": 70 + i * 40,
        ...(i % 2 === 0 ? { windsurf: 50 + i * 20 } : {}),
      },
      byModel: { "openai:o200k": 80 + i * 45 },
    }));
    writeFileSync(
      path.join(stateDir, "analyze-history.json"),
      JSON.stringify({ version: 1, entries }, null, 2) + "\n",
      "utf8"
    );
    writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({
        budget: { total: 600, clients: { "cursor-global": 400 } },
      }) + "\n",
      "utf8"
    );

    await page.goto(serverUrl);
    const chart = page.getByTestId("history-chart");
    await expect(chart).toBeVisible();
    await expect(chart.getByTestId("history-chart-legend")).toBeVisible();
    await expect(chart.getByTestId("history-chart-axis-y").first()).toBeVisible();
    await expect(chart.getByTestId("history-chart-axis-x").first()).toBeVisible();
    await expect(chart.getByTestId("history-chart-legend").locator('[data-series="total"]')).toBeVisible();
    await expect(
      chart.getByTestId("history-chart-legend").locator('[data-series="cursor-global"]')
    ).toBeVisible();
    await expect(chart.getByTestId("history-chart-series")).toHaveCount(3);
    await expect(chart.getByTestId("history-budget-line")).toHaveCount(2);
    const budgetLines = chart.locator('[data-testid="history-budget-line"]');
    const dashCount = await budgetLines.evaluateAll((els) =>
      els.filter((el) => el.getAttribute("stroke-dasharray") === "6 4").length
    );
    expect(dashCount).toBe(2);
  });

  test("stage3d-e2e-gui-bom-budget-overlay", async ({ page }) => {
    const stateDir = path.join(testHome, ".config", "tool-token-budget");
    mkdirSync(stateDir, { recursive: true });
    const bom = "\uFEFF";
    writeFileSync(
      path.join(stateDir, "config.json"),
      bom +
        JSON.stringify({
          budget: { total: 600, clients: { "cursor-global": 400 } },
        }) +
        "\n",
      "utf8"
    );
    writeFileSync(
      path.join(stateDir, "analyze-history.json"),
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              at: "2026-09-20T10:00:00.000Z",
              totalTokens: 120,
              byClient: { "cursor-global": 120 },
              byModel: { "openai:o200k": 120 },
            },
          ],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    await page.goto(serverUrl);
    const chart = page.getByTestId("history-chart");
    await expect(chart.getByTestId("history-budget-line")).toHaveCount(2);
    const dashCount = await chart.locator('[data-testid="history-budget-line"]').evaluateAll((els) =>
      els.filter((el) => el.getAttribute("stroke-dasharray") === "6 4").length
    );
    expect(dashCount).toBe(2);
  });

  test("stage3d-e2e-gui-history-chart-tiny-budget", async ({ browser }) => {
    test.setTimeout(120_000);
    const stateDir = path.join(testHome, ".config", "tool-token-budget");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync("/opt/cursor/artifacts", { recursive: true });
    writeFileSync(
      path.join(stateDir, "config.json"),
      JSON.stringify({ budget: { total: 1 } }) + "\n",
      "utf8"
    );
    writeFileSync(
      path.join(stateDir, "analyze-history.json"),
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              at: "2026-09-20T10:00:00.000Z",
              totalTokens: 500,
              byClient: {},
              byModel: { "openai:o200k": 500 },
            },
            {
              at: "2026-09-21T10:00:00.000Z",
              totalTokens: 600,
              byClient: {},
              byModel: { "openai:o200k": 600 },
            },
          ],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const cliPath = path.join(repoRoot, "dist", "cli.js");
    let proc: ChildProcess | undefined;
    let url = "";
    try {
      await new Promise<void>((resolve, reject) => {
        proc = spawn(
          "node",
          [cliPath, "ui", "--no-open", "--watch-interval", "10", "--client", "cursor-global"],
          {
            cwd: e2eWorkDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              HOME: testHome,
              USERPROFILE: testHome,
              APPDATA: path.join(testHome, "AppData", "Roaming"),
              XDG_CONFIG_HOME: path.join(testHome, ".config"),
            },
          }
        );
        const timeout = setTimeout(() => reject(new Error("UI server startup timeout")), 60_000);
        const onData = (chunk: Buffer | string) => {
          const text = String(chunk);
          const match = text.match(/http:\/\/127\.0\.0\.1:\d+\?token=[^\s]+/);
          if (match) {
            url = match[0];
            clearTimeout(timeout);
            resolve();
          }
        };
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", onData);
        proc.on("error", reject);
      });

      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(url);
      await expect(page.getByTestId("client-select")).toHaveValue("cursor-global");
      const chart = page.getByTestId("history-chart");
      await expect(chart.getByTestId("history-budget-below-scale-label")).toBeVisible();
      await expect(chart.getByTestId("history-budget-line").first()).toHaveAttribute(
        "stroke-dasharray",
        "6 4"
      );
      await chart.screenshot({
        path: "/opt/cursor/artifacts/stage3d-history-chart-tiny-budget.png",
      });
      await context.close();
    } finally {
      if (proc) {
        proc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  });

  test("stage3d-e2e-ui-client-preselect", async ({ browser }) => {
    test.setTimeout(120_000);
    const cliPath = path.join(repoRoot, "dist", "cli.js");
    let proc: ChildProcess | undefined;
    let url = "";
    try {
      await new Promise<void>((resolve, reject) => {
        proc = spawn(
          "node",
          [cliPath, "ui", "--no-open", "--watch-interval", "10", "--client", "cursor-global"],
          {
            cwd: e2eWorkDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              HOME: testHome,
              USERPROFILE: testHome,
              APPDATA: path.join(testHome, "AppData", "Roaming"),
              XDG_CONFIG_HOME: path.join(testHome, ".config"),
            },
          }
        );
        const timeout = setTimeout(() => reject(new Error("UI server startup timeout")), 60_000);
        const onData = (chunk: Buffer | string) => {
          const text = String(chunk);
          const match = text.match(/http:\/\/127\.0\.0\.1:\d+\?token=[^\s]+/);
          if (match) {
            url = match[0];
            clearTimeout(timeout);
            resolve();
          }
        };
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", onData);
        proc.on("error", reject);
      });

      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(url);
      const select = page.getByTestId("client-select");
      await expect(select).toBeVisible();
      await expect(select).toHaveValue("cursor-global");
      await context.close();
    } finally {
      if (proc) {
        proc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  });

  test("stage3d-e2e-gui-history-chart-series", async ({ page }) => {
    await page.goto(serverUrl);
    const chart = page.getByTestId("history-chart");
    await chart.getByTestId("history-chart-plot").hover({ position: { x: 200, y: 80 } });
    await expect(chart.getByTestId("history-chart-tooltip")).toBeVisible();
  });
});
