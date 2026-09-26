import { spawnSync } from "node:child_process";

const projects = ["parallel", "ui-servers"];
let failed = false;

for (const project of projects) {
  const result = spawnSync(
    process.execPath,
    ["./node_modules/vitest/vitest.mjs", "run", "--project", project],
    { stdio: "inherit", cwd: process.cwd() }
  );
  if (result.status !== 0) {
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
