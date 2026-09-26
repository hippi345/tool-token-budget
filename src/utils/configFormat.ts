import { parseJSON } from "./json.js";

/** Deep equality for parsed MCP config objects (ignores formatting). */
export function configsSemanticallyEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

export function detectTextEol(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Guess indentation from the first indented line, default two spaces. */
export function detectJsonIndent(content: string): string {
  const match = content.match(/\r?\n([ \t]+)"/);
  if (!match) {
    return "  ";
  }
  return match[1].includes("\t") ? "\t" : match[1];
}

function originalEndsWithNewline(content: string): boolean {
  return /(?:\r\n|\n|\r)$/.test(content);
}

export function serializeJsonPreservingStyle(value: unknown, originalContent: string): string {
  const indent = detectJsonIndent(originalContent);
  const eol = detectTextEol(originalContent);
  const body = JSON.stringify(value, null, indent).replace(/\n/g, eol);
  if (originalEndsWithNewline(originalContent)) {
    return body + eol;
  }
  return body;
}

export function parseConfigFile(content: string): unknown {
  return parseJSON(content);
}
