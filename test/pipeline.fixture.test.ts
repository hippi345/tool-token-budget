import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadToolsJson } from "../src/discover/fromToolsJson.js";
import { analyzeTools, formatTextReport } from "../src/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bloatedPath = path.join(__dirname, "../fixtures/tools-bloated.json");

describe("pipeline fixtures", () => {
  it("loads bloated fixture, ranks mega_search first, finds lints, text has estimate", async () => {
    const { servers, tools } = await loadToolsJson(bloatedPath);
    expect(tools.length).toBeGreaterThan(0);

    const report = analyzeTools(tools, servers);
    expect(report.tools[0].name).toBe("mega_search");
    expect(report.findings.length).toBeGreaterThan(0);

    const text = formatTextReport(report);
    expect(text.toLowerCase()).toContain("estimate");
    expect(text).toContain("mega_search");
  });
});
