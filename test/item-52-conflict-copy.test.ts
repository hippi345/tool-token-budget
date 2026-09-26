import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_BASELINE_CONFLICT_MESSAGE } from "../src/ui/conflictMessages.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("item 52: baseline conflict copy", () => {
  it("uses refreshed-dashboard message and not Re-analyze", async () => {
    expect(CONFIG_BASELINE_CONFLICT_MESSAGE).toContain("dashboard is refreshing");
    expect(CONFIG_BASELINE_CONFLICT_MESSAGE).not.toMatch(/Re-analyze/i);

    const serverSrc = await readFile(path.join(repoRoot, "src", "ui", "server.ts"), "utf8");
    expect(serverSrc).toContain("CONFIG_BASELINE_CONFLICT_MESSAGE");
    expect(serverSrc).not.toContain("Re-analyze the target");

    const editorSrc = await readFile(path.join(repoRoot, "gui", "src", "Editor.tsx"), "utf8");
    expect(editorSrc).not.toMatch(/Re-analyze/i);
  });
});
