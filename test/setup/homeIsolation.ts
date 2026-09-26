import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

/** Runs in each vitest worker so HOME isolation applies before tests (globalSetup alone does not). */
if (!process.env.__TEST_HOME_ISOLATION_APPLIED) {
  const realHome = process.env.__TEST_REAL_HOME || process.env.REAL_HOME;
  if (realHome) {
    process.env.__TEST_REAL_HOME = realHome;
    process.env.REAL_HOME = realHome;
  }

  const testRoot = path.join(process.cwd(), "tmp", "test-isolation");
  mkdirSync(testRoot, { recursive: true });

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
}
