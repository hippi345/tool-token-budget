import { defineConfig } from "vitest/config";
import os from "node:os";

/** Captured when vitest loads config (before per-worker HOME isolation). */
const REAL_HOME_FOR_TESTS = process.env.REAL_HOME || os.homedir();

/**
 * Tests that bind HTTP servers or spawn UI CLI — run sequentially in one fork.
 * npm test runs this project after `parallel` so workers do not share HOME mid-run.
 */
export const UI_SERVER_TEST_FILES = [
  "test/stage-b.test.ts",
  "test/stage-c.test.ts",
  "test/item-10-remote-passthrough.test.ts",
  "test/item-11-ui-remote-preview-apply.test.ts",
  "test/item-13-nested-redaction.test.ts",
  "test/item-14-discovery-gate.test.ts",
  "test/item-21-export-proposed-redaction.test.ts",
  "test/item-22-failed-discovery-preserve.test.ts",
  "test/item-23-initial-discovery-gate.test.ts",
  "test/item-25-request-body-limit.test.ts",
  "test/item-26-export-remote-kept.test.ts",
  "test/item-40-external-config-change.test.ts",
  "test/item-48-apply-retry-and-double.test.ts",
  "test/item-49-apply-preview-token.test.ts",
  "test/item-50-config-resilience.test.ts",
  "test/item-55-bad-config-shape.test.ts",
  "test/item-56-baseline-reconcile-race.test.ts",
  "test/item-58-preview-token-policy.test.ts",
  "test/item-59-config-error-no-secrets.test.ts",
  "test/item-config-parse-surfaces.test.ts",
  "test/item-export-null-config.test.ts",
  "test/item-62-deleted-config-clients.test.ts",
  "test/item-63-apply-validation-order.test.ts",
  "test/item-64-log-once-empty-mcpservers.test.ts",
  "test/stage1-r2-items.test.ts",
];

export default defineConfig({
  test: {
    env: {
      REAL_HOME: REAL_HOME_FOR_TESTS,
      __TEST_REAL_HOME: REAL_HOME_FOR_TESTS,
    },
    globalSetup: ["./test/setup/globalSetup.ts"],
    setupFiles: ["./test/setup/homeIsolation.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "parallel",
          include: ["test/**/*.test.ts"],
          exclude: UI_SERVER_TEST_FILES,
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          name: "ui-servers",
          include: UI_SERVER_TEST_FILES,
          testTimeout: 120_000,
          fileParallelism: false,
          pool: "forks",
          maxWorkers: 1,
          minWorkers: 1,
        },
      },
    ],
  },
});
