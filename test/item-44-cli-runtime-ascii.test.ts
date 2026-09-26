import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { writeArtifacts } from "../src/emit/writeArtifacts.js";
import { analyzeTools } from "../src/pipeline.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertAscii(buf: string, label: string): void {
  for (let i = 0; i < buf.length; i++) {
    if (buf.charCodeAt(i) > 0x7f) {
      throw new Error(`Non-ASCII in ${label} at index ${i}: U+${buf.charCodeAt(i).toString(16)}`);
    }
  }
}

describe("item 44/51: runtime CLI stdout/stderr are ASCII", () => {
  let cliPath: string;
  let stubPath: string;

  beforeAll(() => {
    cliPath = path.join(repoRoot, "dist", "cli.js");
    stubPath = path.join(repoRoot, "fixtures", "stub-mcp-server.mjs");
  });

  it("analyze, tools-json, lint, doctor, emit, apply outputs are ASCII", async () => {
    const testDir = await mkdtemp(path.join(os.tmpdir(), "item44-run-"));
    try {
    const mcpPath = path.join(testDir, "mcp.json");
    const longName = "tool_with_a_very_long_name_that_will_be_truncated_in_table_output";
    await writeFile(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            stub: { command: "node", args: [stubPath] },
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const toolsJsonPath = path.join(testDir, "tools.json");
    await writeFile(
      toolsJsonPath,
      JSON.stringify(
        {
          servers: [
            {
              name: "offline",
              tools: [
                {
                  name: longName,
                  description: "d",
                  inputSchema: { type: "object" },
                },
              ],
            },
          ],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const outDir = path.join(testDir, "out");
    const report = analyzeTools(
      [
        {
          server: "stub",
          name: longName,
          description: "desc",
          inputSchema: { type: "object", properties: { x: { type: "string" } } },
        },
      ],
      [{ name: "stub", status: "ok" }]
    );
    await writeArtifacts(outDir, report, {
      format: "both",
      originalConfig: JSON.parse(await readFile(mcpPath, "utf8")),
      mcpConfigPath: mcpPath,
      policy: { keepPerServer: 2 },
    });
    const proposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");

    const cases: Array<{ cmd: string; args: string[] }> = [
      { cmd: "analyze", args: [mcpPath] },
      { cmd: "analyze", args: ["--tools-json", toolsJsonPath] },
      { cmd: "lint-server", args: ["--tools-json", toolsJsonPath] },
      { cmd: "doctor", args: [] },
      { cmd: "emit", args: [mcpPath, "--out", outDir] },
      {
        cmd: "apply",
        args: ["--mcp-config", mcpPath, "--proposed", proposedPath, "--yes", "--dry-run"],
      },
    ];

    for (const { cmd, args } of cases) {
      let stdout = "";
      let stderr = "";
      try {
        stdout = execSync(`node "${cliPath}" ${cmd} ${args.map((a) => `"${a}"`).join(" ")}`, {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, HOME: testDir, USERPROFILE: testDir },
        });
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string };
        stdout = (e.stdout ?? "") + (e.stderr ?? "");
        stderr = e.stderr ?? "";
      }
      assertAscii(stdout + stderr, cmd);
    }
    } finally {
      await rm(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
