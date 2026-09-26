import { describe, it, expect } from "vitest";
import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

describe("Test artifact isolation", () => {
  it("ensures no test artifacts are left in tool-token-budget-export/", () => {
    for (const dirName of ["tool-token-budget-export", "schema-budget-export"]) {
      const exportDir = path.join(repoRoot, dirName);
      if (!existsSync(exportDir)) {
        continue;
      }
      const entries = readdirSync(exportDir);
      expect(entries).toHaveLength(0);
      if (entries.length > 0) {
        throw new Error(
          `Test artifacts found in ${dirName}/: ${entries.join(", ")}. ` +
            `Tests must write to os.tmpdir() only.`
        );
      }
    }
  });

  it("ensures no test artifacts are left in tmp/", () => {
    const tmpDir = path.join(repoRoot, "tmp");
    
    if (existsSync(tmpDir)) {
      const entries = readdirSync(tmpDir);
      
      // Filter out the special test-isolation directory which is managed by vitest
      const artifactEntries = entries.filter(entry => entry !== "test-isolation");
      
      expect(artifactEntries).toHaveLength(0);
      
      if (artifactEntries.length > 0) {
        throw new Error(
          `Test artifacts found in tmp/: ${artifactEntries.join(", ")}. ` +
          `Tests must write to os.tmpdir() only and clean up after themselves.`
        );
      }
    }
  });

  it("verifies test directories use os.tmpdir() pattern", () => {
    // This is a meta-test that checks common test patterns
    // It ensures we don't accidentally reintroduce hardcoded repo paths
    const testFiles = [
      "test/stage-b.test.ts",
      "test/cli-regression.test.ts",
      "test/apply.test.ts",
      "test/emit.test.ts",
      "test/live-run-fixes.test.ts",
      "test/path-containment.test.ts",
    ];

    for (const testFile of testFiles) {
      const fullPath = path.join(repoRoot, testFile);
      if (existsSync(fullPath)) {
        const content = require("fs").readFileSync(fullPath, "utf8");
        
        // Check for suspicious patterns that write to repo directories
        const badPatterns = [
          /__dirname.*\.\.\/tmp\//,
          /path\.join\(__dirname.*tmp/,
        ];

        for (const pattern of badPatterns) {
          if (pattern.test(content)) {
            throw new Error(
              `Test file ${testFile} contains suspicious pattern ${pattern.source}. ` +
              `Use os.tmpdir() instead of repo-relative paths.`
            );
          }
        }
      }
    }
  });
});
