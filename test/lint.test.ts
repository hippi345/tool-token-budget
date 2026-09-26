import { describe, it, expect } from "vitest";
import { lintTools, DESC_CHARS, SCHEMA_TOKENS, ENUM_LEN, MAX_DEPTH } from "../src/lint/run.js";
import { meterTool } from "../src/meter/score.js";
import type { Tool } from "../src/types.js";

function tool(partial: Partial<Tool> & Pick<Tool, "name">): Tool {
  return {
    server: partial.server ?? "demo",
    name: partial.name,
    description: partial.description ?? "",
    inputSchema: partial.inputSchema ?? { type: "object", properties: {} },
  };
}

describe("lint thresholds exports", () => {
  it("exports documented defaults", () => {
    expect(DESC_CHARS).toBe(500);
    expect(SCHEMA_TOKENS).toBe(800);
    expect(ENUM_LEN).toBe(50);
    expect(MAX_DEPTH).toBe(6);
  });
});

describe("description-too-long", () => {
  it("warns when description exceeds DESC_CHARS", () => {
    const t = tool({
      name: "verbose",
      description: "x".repeat(DESC_CHARS + 1),
    });
    const findings = lintTools([t], [meterTool(t)]);
    expect(findings.some((f) => f.ruleId === "description-too-long" && f.severity === "warn")).toBe(true);
  });
});

describe("schema-too-large", () => {
  it("warns when schema estimate exceeds SCHEMA_TOKENS", () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) {
      props[`field_${i}_with_a_somewhat_long_name`] = {
        type: "string",
        description: "A fairly long description that pads the schema token count " + i,
      };
    }
    const t = tool({ name: "huge", inputSchema: { type: "object", properties: props } });
    const m = meterTool(t);
    expect(m.breakdown.schema).toBeGreaterThan(SCHEMA_TOKENS);
    const findings = lintTools([t], [m]);
    expect(findings.some((f) => f.ruleId === "schema-too-large" && f.severity === "warn")).toBe(true);
  });
});

describe("huge-enum", () => {
  it("warns when an enum has more than ENUM_LEN values", () => {
    const values = Array.from({ length: ENUM_LEN + 1 }, (_, i) => `v${i}`);
    const t = tool({
      name: "enumy",
      inputSchema: {
        type: "object",
        properties: { choice: { type: "string", enum: values } },
      },
    });
    const findings = lintTools([t], [meterTool(t)]);
    expect(findings.some((f) => f.ruleId === "huge-enum" && f.severity === "warn")).toBe(true);
  });
});

describe("deep-schema", () => {
  it("infos when nesting depth exceeds MAX_DEPTH", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < MAX_DEPTH + 2; i++) {
      schema = { type: "object", properties: { nested: schema } };
    }
    const t = tool({ name: "deep", inputSchema: schema });
    const findings = lintTools([t], [meterTool(t)]);
    expect(findings.some((f) => f.ruleId === "deep-schema" && f.severity === "info")).toBe(true);
  });
});

describe("duplicate-description-boilerplate", () => {
  it("infos when >=2 tools share identical description longer than 40 chars", () => {
    const boilerplate =
      "This is a shared boilerplate description used by multiple tools intentionally.";
    expect(boilerplate.length).toBeGreaterThan(40);
    const a = tool({ name: "a", description: boilerplate });
    const b = tool({ name: "b", description: boilerplate });
    const findings = lintTools([a, b], [meterTool(a), meterTool(b)]);
    const dups = findings.filter((f) => f.ruleId === "duplicate-description-boilerplate");
    expect(dups.length).toBeGreaterThanOrEqual(2);
    expect(dups.every((f) => f.severity === "info")).toBe(true);
  });

  it("does not flag short identical descriptions", () => {
    const a = tool({ name: "a", description: "short same" });
    const b = tool({ name: "b", description: "short same" });
    const findings = lintTools([a, b], [meterTool(a), meterTool(b)]);
    expect(findings.every((f) => f.ruleId !== "duplicate-description-boilerplate")).toBe(true);
  });
});
