import { parse as parseJsonc, type ParseError } from "jsonc-parser";

/**
 * Strip UTF-8 BOM from the beginning of a string.
 * PowerShell 5 and some editors write a BOM, which breaks JSON.parse.
 */
export function stripBOM(content: string): string {
  if (content.charCodeAt(0) === 0xFEFF) {
    return content.slice(1);
  }
  return content;
}

function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split(/\r\n|\n|\r/);
  return { line: lines.length, column: (lines[lines.length - 1] ?? "").length + 1 };
}

function formatJsoncParseErrors(content: string, errors: ParseError[]): string {
  const first = errors[0];
  if (!first) {
    return "JSON syntax error";
  }
  const { line, column } = offsetToLineColumn(content, first.offset);
  return `JSON syntax error at line ${line} column ${column}`;
}

/**
 * Parse JSON/JSONC with BOM stripping (comments and trailing commas allowed).
 */
export function parseJSON<T = unknown>(content: string): T {
  const stripped = stripBOM(content);
  const errors: ParseError[] = [];
  const parsed = parseJsonc(stripped, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new SyntaxError(formatJsoncParseErrors(stripped, errors));
  }
  return parsed as T;
}
