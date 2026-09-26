import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyConfig } from "../src/apply/applyConfig.js";
import { analyzeTools } from "../src/pipeline.js";
import { writeArtifacts } from "../src/emit/writeArtifacts.js";

describe("item 24: semantic no-op apply preserves CRLF and indent", () => {
  it("does not write or backup when CRLF config matches proposal semantically", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "item24-crlf-"));
    const mcpPath = path.join(testDir, "mcp.json");
    const config = { mcpServers: { a: { command: "node", args: ["x.js"] } } };
    const crlfBody =
      "{\r\n" +
      '  "mcpServers": {\r\n' +
      '    "a": {\r\n' +
      '      "command": "node",\r\n' +
      '      "args": ["x.js"]\r\n' +
      "    }\r\n" +
      "  }\r\n" +
      "}\r\n";
    await writeFile(mcpPath, crlfBody, "utf8");

    const report = analyzeTools(
      [{ server: "a", name: "t1", description: "d", inputSchema: { type: "object" } }],
      [{ name: "a", status: "ok" }]
    );
    const outDir = path.join(testDir, "out");
    await writeArtifacts(outDir, report, {
      format: "both",
      originalConfig: config,
      mcpConfigPath: mcpPath,
      policy: { keepPerServer: 5 },
    });

    const proposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");
    const result = await applyConfig({
      mcpConfigPath: mcpPath,
      proposedPath,
      dryRun: false,
      backup: true,
      yes: true,
    });
    expect(result.success).toBe(true);
    expect(result.noOp).toBe(true);
    const after = await readFile(mcpPath, "utf8");
    expect(after).toBe(crlfBody);

    await rm(testDir, { recursive: true, force: true });
  });

  it("preserves four-space indent when config is unchanged semantically", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "item24-4sp-"));
    const mcpPath = path.join(testDir, "mcp.json");
    const fourSpace =
      "{\n" +
      '    "mcpServers": {\n' +
      '        "a": {\n' +
      '            "command": "node",\n' +
      '            "args": ["x.js"]\n' +
      "        }\n" +
      "    }\n" +
      "}\n";
    await writeFile(mcpPath, fourSpace, "utf8");
    const config = JSON.parse(fourSpace);

    const report = analyzeTools(
      [{ server: "a", name: "t1", description: "d", inputSchema: { type: "object" } }],
      [{ name: "a", status: "ok" }]
    );
    const outDir = path.join(testDir, "out");
    await writeArtifacts(outDir, report, {
      format: "both",
      originalConfig: config,
      mcpConfigPath: mcpPath,
      policy: { keepPerServer: 5 },
    });

    const proposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");
    const result = await applyConfig({
      mcpConfigPath: mcpPath,
      proposedPath,
      dryRun: false,
      backup: true,
      yes: true,
    });
    expect(result.success).toBe(true);
    expect(result.noOp).toBe(true);
    const after = await readFile(mcpPath, "utf8");
    expect(after).toBe(fourSpace);

    await rm(testDir, { recursive: true, force: true });
  });
});
