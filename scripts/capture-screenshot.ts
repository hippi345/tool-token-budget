import { chromium } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function captureScreenshot() {
  let serverProcess: ChildProcess | null = null;
  let serverUrl: string | null = null;

  try {
    // Start server with fixture
    const fixturePath = path.join(__dirname, "..", "fixtures", "tools-tiny.json");
    const cliPath = path.join(__dirname, "..", "dist", "cli.js");

    console.log("Starting UI server...");
    await new Promise<void>((resolve, reject) => {
      serverProcess = spawn("node", [cliPath, "ui", "--no-open", "--tools-json", fixturePath], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      serverProcess.stdout?.on("data", (data) => {
        const chunk = data.toString();
        output += chunk;
        const match = output.match(/UI running at: (http:\/\/127\.0\.0\.1:\d+\?token=[a-f0-9]+)/);
        if (match) {
          serverUrl = match[1];
          console.log("Server started at:", serverUrl);
          setTimeout(() => resolve(), 2000);
        }
      });

      serverProcess.stderr?.on("data", (data) => {
        console.error("Server stderr:", data.toString());
      });

      serverProcess.on("error", (err) => {
        reject(err);
      });

      setTimeout(() => {
        reject(new Error("Server failed to start within timeout"));
      }, 15000);
    });

    if (!serverUrl) {
      throw new Error("Failed to get server URL");
    }

    console.log("Launching browser...");
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });

    console.log("Loading dashboard...");
    await page.goto(serverUrl);
    await page.waitForTimeout(3000);

    // Ensure screenshots directory exists
    await mkdir(path.join(__dirname, "..", "screenshots"), { recursive: true });

    console.log("Capturing screenshot...");
    const screenshotPath = path.join(__dirname, "..", "screenshots", "dashboard-stage-b.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Screenshot saved to: ${screenshotPath}`);

    await browser.close();
  } finally {
    if (serverProcess) {
      console.log("Stopping server...");
      serverProcess.kill();
    }
  }
}

captureScreenshot().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
