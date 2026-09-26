#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shortSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).stdout.trim();
const outPath = path.join("/opt/cursor/artifacts", `tool-token-budget-${shortSha}.zip`);

const excludes = [
  "node_modules/*",
  "gui/node_modules/*",
  "dist/*",
  "gui/dist/*",
  ".git/*",
  "playwright-report/*",
  "test-results/*",
  "tmp/*",
  ".github/*",
  ".gitignore",
];

const args = ["-r", outPath, "."];
for (const ex of excludes) {
  args.push("-x", ex);
}

const result = spawnSync("zip", args, { cwd: repoRoot, stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(outPath);
