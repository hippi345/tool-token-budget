import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

export default function setup() {
  // Record the real user home once (vitest runs this per project; homedir() may already be faked).
  if (!process.env.__TEST_REAL_HOME) {
    process.env.__TEST_REAL_HOME = os.userInfo().homedir;
  }
  if (!process.env.REAL_HOME) {
    process.env.REAL_HOME = process.env.__TEST_REAL_HOME;
  }

  // Create isolated temp directories for all tests
  const testRoot = path.join(process.cwd(), "tmp", "test-isolation");
  mkdirSync(testRoot, { recursive: true });

  // Override all home/config directory environment variables
  process.env.HOME = testRoot;
  process.env.USERPROFILE = testRoot;
  process.env.APPDATA = path.join(testRoot, "AppData", "Roaming");
  process.env.LOCALAPPDATA = path.join(testRoot, "AppData", "Local");
  process.env.XDG_CONFIG_HOME = path.join(testRoot, ".config");
  process.env.XDG_DATA_HOME = path.join(testRoot, ".local", "share");

  // Create necessary directories
  mkdirSync(process.env.APPDATA, { recursive: true });
  mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });

  console.log(`Test isolation: HOME=${testRoot}`);
  console.log(`Real home (forbidden): ${process.env.__TEST_REAL_HOME}`);
}
