import type { LintFinding, Tool, ToolMeter } from "../types.js";
import {
  DESC_CHARS,
  SCHEMA_TOKENS,
  ENUM_LEN,
  MAX_DEPTH,
  maxEnumLength,
  schemaDepth,
} from "./rules.js";

export { DESC_CHARS, SCHEMA_TOKENS, ENUM_LEN, MAX_DEPTH };

export function lintTools(tools: Tool[], meters: ToolMeter[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const meterByKey = new Map<string, ToolMeter>(
    meters.map((m) => [`${m.server}::${m.name}`, m])
  );

  for (const tool of tools) {
    const key = `${tool.server}::${tool.name}`;
    const meter = meterByKey.get(key);

    if ((tool.description ?? "").length > DESC_CHARS) {
      findings.push({
        ruleId: "description-too-long",
        severity: "warn",
        server: tool.server,
        tool: tool.name,
        message: `Description is ${tool.description.length} chars (threshold ${DESC_CHARS})`,
        suggestion: "Shorten the description; move detail into docs.",
      });
    }

    if (meter && meter.breakdown.schema > SCHEMA_TOKENS) {
      findings.push({
        ruleId: "schema-too-large",
        severity: "warn",
        server: tool.server,
        tool: tool.name,
        message: `Schema estimate ${meter.breakdown.schema} tokens (threshold ${SCHEMA_TOKENS})`,
        suggestion: "Split parameters or remove unused properties.",
      });
    }

    const enumLen = maxEnumLength(tool.inputSchema);
    if (enumLen > ENUM_LEN) {
      findings.push({
        ruleId: "huge-enum",
        severity: "warn",
        server: tool.server,
        tool: tool.name,
        message: `Enum has ${enumLen} values (threshold ${ENUM_LEN})`,
        suggestion: "Prefer a string pattern or external lookup over huge enums.",
      });
    }

    const depth = schemaDepth(tool.inputSchema);
    if (depth > MAX_DEPTH) {
      findings.push({
        ruleId: "deep-schema",
        severity: "info",
        server: tool.server,
        tool: tool.name,
        message: `Schema nesting depth ${depth} (threshold ${MAX_DEPTH})`,
        suggestion: "Flatten nested objects where possible.",
      });
    }
  }

  // duplicate-description-boilerplate: identical description length > 40 on >=2 tools
  const byDesc = new Map<string, Tool[]>();
  for (const tool of tools) {
    const d = tool.description ?? "";
    if (d.length <= 40) continue;
    const list = byDesc.get(d) ?? [];
    list.push(tool);
    byDesc.set(d, list);
  }
  for (const [desc, group] of byDesc) {
    if (group.length < 2) continue;
    for (const tool of group) {
      findings.push({
        ruleId: "duplicate-description-boilerplate",
        severity: "info",
        server: tool.server,
        tool: tool.name,
        message: `Identical description shared by ${group.length} tools (${desc.length} chars)`,
        suggestion: "Differentiate tool descriptions or factor shared text out of schemas.",
      });
    }
  }

  return findings;
}
