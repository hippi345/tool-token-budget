import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export default function globalSetup() {
  // If running with fake home, ensure Playwright can find browsers
  // The loader resolves real home via os.userInfo() and sets PLAYWRIGHT_BROWSERS_PATH
  const currentHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
  
  if (currentHome.includes("/tmp/fake-home") || currentHome.includes("\\tmp\\fake-home")) {
    const realHome = process.env.REAL_HOME;
    
    if (!realHome) {
      throw new Error("REAL_HOME not set by loader - this should not happen");
    }
    
    // Resolve real browser path
    let realBrowserPath;
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
      realBrowserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    } else if (process.platform === "win32") {
      realBrowserPath = path.join(realHome, "AppData", "Local", "ms-playwright");
    } else if (process.platform === "darwin") {
      realBrowserPath = path.join(realHome, "Library", "Caches", "ms-playwright");
    } else {
      realBrowserPath = path.join(realHome, ".cache", "ms-playwright");
    }
    
    // Determine fake browser path (platform-specific)
    const fakeBrowserPath = process.platform === "win32"
      ? path.join(currentHome, "AppData", "Local", "ms-playwright")
      : (process.platform === "darwin"
          ? path.join(currentHome, "Library", "Caches", "ms-playwright")
          : path.join(currentHome, ".cache", "ms-playwright"));
    
    // Verify real browser path exists
    if (!fs.existsSync(realBrowserPath)) {
      throw new Error(`Real browser path does not exist: ${realBrowserPath}. Run: npx playwright install chromium`);
    }
    
    // Create parent directory in fake home if needed
    const cacheParent = path.dirname(fakeBrowserPath);
    if (!fs.existsSync(cacheParent)) {
      fs.mkdirSync(cacheParent, { recursive: true });
    }
    
    // Create symlink to real browser cache (if not already exists)
    if (!fs.existsSync(fakeBrowserPath)) {
      try {
        // On Windows, use junction; on other OSes, use directory symlink
        const linkType = process.platform === "win32" ? "junction" : "dir";
        fs.symlinkSync(realBrowserPath, fakeBrowserPath, linkType);
        console.log(`Created symlink: ${fakeBrowserPath} -> ${realBrowserPath}`);
      } catch (err) {
        // Symlink failed, PLAYWRIGHT_BROWSERS_PATH should still work
        console.warn(`Warning: Could not create symlink: ${err.message}`);
        console.warn(`Using PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH || realBrowserPath}`);
        process.env.PLAYWRIGHT_BROWSERS_PATH = realBrowserPath;
      }
    }
  }
}


