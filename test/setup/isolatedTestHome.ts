import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";

const ISOLATED_HOME_PREFIX = "tool-token-budget-vitest-";

/** Record the machine profile dir once (immune to later HOME overrides). */
export function captureRealHomeForTests(): string {
  if (!process.env.__TEST_REAL_HOME) {
    process.env.__TEST_REAL_HOME = os.userInfo().homedir;
  }
  if (!process.env.REAL_HOME) {
    process.env.REAL_HOME = process.env.__TEST_REAL_HOME;
  }
  return process.env.__TEST_REAL_HOME;
}

/** Unique isolated HOME per vitest worker under os.tmpdir() (not under the repo checkout). */
export function applyIsolatedTestHomeEnv(): string {
  if (process.env.__TEST_HOME_ISOLATION_APPLIED === "1" && process.env.__TEST_ISOLATED_HOME) {
    return process.env.__TEST_ISOLATED_HOME;
  }

  captureRealHomeForTests();

  const testRoot = mkdtempSync(path.join(os.tmpdir(), ISOLATED_HOME_PREFIX));
  process.env.__TEST_ISOLATED_HOME = testRoot;
  process.env.HOME = testRoot;
  process.env.USERPROFILE = testRoot;
  process.env.APPDATA = path.join(testRoot, "AppData", "Roaming");
  process.env.LOCALAPPDATA = path.join(testRoot, "AppData", "Local");
  process.env.XDG_CONFIG_HOME = path.join(testRoot, ".config");
  process.env.XDG_DATA_HOME = path.join(testRoot, ".local", "share");

  mkdirSync(process.env.APPDATA, { recursive: true });
  mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });

  process.env.__TEST_HOME_ISOLATION_APPLIED = "1";
  return testRoot;
}
