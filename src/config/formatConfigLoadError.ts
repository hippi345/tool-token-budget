import { redactSecrets } from "../utils/redact.js";

const UNRECOGNIZED_SHAPE_MESSAGE =
  "Unrecognized config shape (expected mcpServers object or tools-json servers array)";

const INVALID_MCP_SERVERS_MESSAGE =
  "Invalid MCP config: mcpServers must be a non-null object";

const JSON_SYNTAX_PREFIX = "JSON syntax error at line ";

function extractJsonLineColumn(msg: string): { line: string; column: string } | null {
  const m = msg.match(/\(line (\d+) column (\d+)\)/i);
  if (!m) {
    return null;
  }
  return { line: m[1]!, column: m[2]! };
}

function jsonSyntaxMessage(msg: string): string | null {
  const loc = extractJsonLineColumn(msg);
  if (!loc) {
    return null;
  }
  return `${JSON_SYNTAX_PREFIX}${loc.line} column ${loc.column}`;
}

/** Drop V8 parser source previews (may follow the main line across CRLF/LF). */
function dropParserSourcePreview(msg: string): string {
  const normalized = msg.replace(/\r\n/g, "\n");
  const firstLine = normalized.split("\n")[0] ?? normalized;
  const syntax = jsonSyntaxMessage(firstLine);
  if (syntax) {
    return syntax;
  }
  if (/in JSON at position/i.test(firstLine)) {
    const syntaxFromFirst = jsonSyntaxMessage(firstLine);
    if (syntaxFromFirst) {
      return syntaxFromFirst;
    }
  }
  return firstLine.trim();
}

/**
 * User-safe config load message: never echo file bytes or secret-like snippets.
 * Use this for every path that surfaces a config parse/read error to users or logs.
 */
export function formatConfigLoadError(err: unknown): string {
  if (err instanceof Error && err.message === UNRECOGNIZED_SHAPE_MESSAGE) {
    return UNRECOGNIZED_SHAPE_MESSAGE;
  }
  if (err instanceof Error && err.message === INVALID_MCP_SERVERS_MESSAGE) {
    return INVALID_MCP_SERVERS_MESSAGE;
  }

  const msg = err instanceof Error ? err.message : String(err);
  const redacted = String(redactSecrets(msg));
  const head = redacted.replace(/\r\n/g, "\n").split("\n")[0] ?? redacted;

  const syntaxFromHead = jsonSyntaxMessage(head);
  if (syntaxFromHead && /in JSON at position/i.test(head)) {
    return syntaxFromHead;
  }

  if (/^Unexpected (token|string|end|number|identifier|property)/i.test(head.trim())) {
    if (/is not valid JSON/i.test(head)) {
      return "JSON syntax error: invalid token or unquoted value";
    }
    const syntax = jsonSyntaxMessage(head);
    if (syntax) {
      return syntax;
    }
  }

  if (/unexpected end of json input/i.test(redacted)) {
    return "Config file is empty or truncated";
  }

  if (/unrecognized config shape/i.test(redacted)) {
    return UNRECOGNIZED_SHAPE_MESSAGE;
  }
  if (/enoent|no such file or directory/i.test(redacted)) {
    return "Config file is missing or unreadable";
  }

  if (/invalid mcp config/i.test(redacted)) {
    if (/missing mcpServers object/i.test(redacted)) {
      return INVALID_MCP_SERVERS_MESSAGE;
    }
    return head.replace(/:.*/, "").trim() || INVALID_MCP_SERVERS_MESSAGE;
  }

  if (/^Expected /i.test(head.trim())) {
    const syntax = jsonSyntaxMessage(head);
    if (syntax) {
      return syntax;
    }
  }

  const withoutSnippet = dropParserSourcePreview(redacted);
  if (withoutSnippet && !/[\r\n]/.test(withoutSnippet)) {
    const syntax = jsonSyntaxMessage(withoutSnippet);
    if (syntax) {
      return syntax;
    }
    if (/^Unexpected /i.test(withoutSnippet)) {
      const fromUnexpected = jsonSyntaxMessage(head);
      if (fromUnexpected) {
        return fromUnexpected;
      }
    }
    return withoutSnippet;
  }

  if (/Unexpected (token|string|end|number|identifier|property)/i.test(redacted) && /is not valid JSON/i.test(redacted)) {
    return "JSON syntax error: invalid token or unquoted value";
  }

  const fallbackSyntax = jsonSyntaxMessage(redacted);
  if (fallbackSyntax) {
    return fallbackSyntax;
  }

  const collapsed = dropParserSourcePreview(redacted);
  if (/Unexpected/i.test(collapsed) && /is not valid JSON/i.test(collapsed)) {
    return "JSON syntax error: invalid token or unquoted value";
  }

  return collapsed || "Config file cannot be read";
}

export function unrecognizedConfigShapeMessage(): string {
  return UNRECOGNIZED_SHAPE_MESSAGE;
}

export function invalidMcpServersObjectMessage(): string {
  return INVALID_MCP_SERVERS_MESSAGE;
}
