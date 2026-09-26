#!/usr/bin/env node

// Pre-loader for Playwright e2e tests
// Sets PLAYWRIGHT_BROWSERS_PATH to work with fake HOME in isolated tests
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// Resolve real home directory using os.userInfo() which reads passwd/Windows profile
// and is NOT affected by HOME or USERPROFILE environment variables
const realHome = (() => {
  // Allow explicit override via REAL_HOME
  if (process.env.REAL_HOME) {
    return process.env.REAL_HOME;
  }
  
  try {
    // os.userInfo().homedir reads from passwd (Unix) or user profile (Windows)
    // and is not affected by HOME/USERPROFILE environment variables
    return os.userInfo().homedir;
  } catch (err) {
    // Fallback if userInfo fails (rare)
    console.warn("Could not read real home from os.userInfo(), using environment");
    return process.env.HOME || process.env.USERPROFILE || os.homedir();
  }
})();

// Set PLAYWRIGHT_BROWSERS_PATH to point to real home's browser cache
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const browserPath = process.platform === "win32"
    // On Windows, prefer LOCALAPPDATA which is not typically overridden
    ? (process.env.LOCALAPPDATA 
        ? path.join(process.env.LOCALAPPDATA, "ms-playwright")
        : path.join(realHome, "AppData", "Local", "ms-playwright"))
    : (process.platform === "darwin"
        ? path.join(realHome, "Library", "Caches", "ms-playwright")
        : path.join(realHome, ".cache", "ms-playwright"));
  
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath;
}

// Export the machine's real home for guard tests (see docs/testing.md).
// This is intentional: e2e sets HOME/USERPROFILE to an isolated fake home, but
// isDangerousTestHome() must compare against the true profile dir from passwd,
// not the overridden HOME. playwright-setup.ts uses REAL_HOME for browser caches.
process.env.REAL_HOME = realHome;

// Pass through extra CLI args (e.g. --reporter=list) from npm run test:e2e --
const playwrightExtraArgs = process.argv.slice(2);

// Spawn the actual playwright test command with the correct environment
// Use Node to invoke Playwright CLI directly to avoid Windows npx.cmd issues
let playwright;
try {
  const playwrightCliPath = require.resolve("@playwright/test/cli");
  playwright = spawn(process.execPath, [playwrightCliPath, "test", ...playwrightExtraArgs], {
    stdio: "inherit",
    env: process.env,
  });
} catch (err) {
  // Fallback: use npx.cmd on Windows, npx elsewhere
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  playwright = spawn(npxCommand, ["playwright", "test", ...playwrightExtraArgs], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
}

playwright.on("exit", (code) => {
  process.exit(code || 0);
});

