import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyConfig } from "../src/apply/applyConfig.js";
import { analyzeTools } from "../src/pipeline.js";
import { writeArtifacts } from "../src/emit/writeArtifacts.js";
import { serializeJsonPreservingStyle } from "../src/utils/configFormat.js";

const configObj = { mcpServers: { a: { command: "node", args: ["x.js"] } } };

const fixtures = [
  {
    name: "LF with EOF newline",
    content:
      "{\n" +
      '  "mcpServers": {\n' +
      '    "a": { "command": "node", "args": ["x.js"] }\n' +
      "  }\n" +
      "}\n",
  },
  {
    name: "LF without EOF newline",
    content:
      "{\n" +
      '  "mcpServers": {\n' +
      '    "a": { "command": "node", "args": ["x.js"] }\n' +
      "  }\n" +
      "}",
  },
  {
    name: "CRLF with EOF newline",
    content:
      "{\r\n" +
      '  "mcpServers": {\r\n' +
      '    "a": { "command": "node", "args": ["x.js"] }\r\n' +
      "  }\r\n" +
      "}\r\n",
  },
  {
    name: "CRLF without EOF newline",
    content:
      "{\r\n" +
      '  "mcpServers": {\r\n' +
      '    "a": { "command": "node", "args": ["x.js"] }\r\n' +
      "  }\r\n" +
      "}",
  },
];

describe("item 35: preserve EOF newline state on real apply", () => {
  for (const fixture of fixtures) {
    it(fixture.name, async () => {
      const testDir = await mkdtemp(path.join(tmpdir(), "item35-"));
      const mcpPath = path.join(testDir, "mcp.json");
      await writeFile(mcpPath, fixture.content, "utf8");

      const report = analyzeTools(
        [{ server: "a", name: "t1", description: "d", inputSchema: { type: "object" } }],
        [{ name: "a", status: "ok" }]
      );
      const outDir = path.join(testDir, "out");
      await writeArtifacts(outDir, report, {
        format: "both",
        originalConfig: configObj,
        mcpConfigPath: mcpPath,
        policy: { keepPerServer: 5 },
      });

      const proposedPath = path.join(outDir, "mcp.json.tool-token-budget-proposed.json");
      const proposedParsed = JSON.parse(await readFile(proposedPath, "utf8"));
      const serialized = serializeJsonPreservingStyle(
        { ...proposedParsed, mcpServers: { ...proposedParsed.mcpServers, b: { command: "node", args: ["y.js"] } } },
        fixture.content
      );
      await writeFile(proposedPath, serialized, "utf8");

      const result = await applyConfig({
        mcpConfigPath: mcpPath,
        proposedPath,
        dryRun: false,
        backup: true,
        yes: true,
      });
      expect(result.success).toBe(true);
      expect(result.noOp).toBeFalsy();

      const after = await readFile(mcpPath, "utf8");
      const hadEofNewline = /(?:\r\n|\n|\r)$/.test(fixture.content);
      const afterHasEofNewline = /(?:\r\n|\n|\r)$/.test(after);
      expect(afterHasEofNewline).toBe(hadEofNewline);

      await rm(testDir, { recursive: true, force: true });
    });
  }
});
