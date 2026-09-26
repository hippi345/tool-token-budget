import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("item 44: CLI user-facing strings are ASCII", () => {
  it("cli.ts console output strings contain no non-ASCII characters", async () => {
    const cliSource = await readFile(path.join(repoRoot, "src", "cli.ts"), "utf8");
    const lines = cliSource.split("\n");
    for (const line of lines) {
      if (/console\.(log|error|warn)/.test(line)) {
        expect(line).toMatch(/^[\x00-\x7F]*$/);
      }
    }
  });
});
