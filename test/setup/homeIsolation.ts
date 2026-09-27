import { applyIsolatedTestHomeEnv } from "./isolatedTestHome.js";

/** Runs in each vitest worker so HOME isolation applies before tests (globalSetup alone does not). */
if (!process.env.__TEST_HOME_ISOLATION_APPLIED) {
  const testRoot = applyIsolatedTestHomeEnv();
  console.log(`Test isolation: HOME=${testRoot}`);
  console.log(`Real home (forbidden): ${process.env.__TEST_REAL_HOME}`);
}
