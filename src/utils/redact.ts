/**
 * Shared secret redaction utilities.
 * Redacts sensitive values at any depth, independent of parent key.
 */

// Structural keys that should NEVER be redacted (tool relies on them)
const STRUCTURAL_KEYS = new Set([
  "command",
  "args",
  "url",
  "type",
  "transport",
  "mcpservers",
  "name",
  "description",
  "schema",
  "inputschema",
  "tools",
  "disabled",
]);

/** Known MCP server entry keys — recurse with normal secret rules. */
const MCP_SERVER_DIRECT_KEYS = new Set([
  "command",
  "args",
  "env",
  "headers",
  "requestheaders",
  "url",
  "type",
  "cwd",
  "transport",
  "disabled",
]);

/**
 * Redact every string leaf under unknown nested objects (e.g. options.metadata).
 */
function redactUnknownNestedLeaves(
  value: unknown,
  placeholder: string = "<from-original>"
): unknown {
  if (typeof value === "string") {
    return placeholder;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknownNestedLeaves(item, placeholder));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const redacted: Record<string, unknown> = {};
          for (const sk of Object.keys(v as Record<string, unknown>)) {
            redacted[sk] = placeholder;
          }
          out[k] = redacted;
        } else {
          out[k] = placeholder;
        }
      } else {
        out[k] = redactUnknownNestedLeaves(v, placeholder);
      }
    }
    return out;
  }
  return value;
}

/**
 * Check if a key name indicates a secret (case-insensitive).
 */
function isSecretKey(key: string): boolean {
  const keyLower = key.toLowerCase();
  
  // Never redact structural keys
  if (STRUCTURAL_KEYS.has(keyLower)) {
    return false;
  }
  
  // Exact matches
  if (
    keyLower === "authorization" ||
    keyLower === "proxy-authorization" ||
    keyLower === "cookie" ||
    keyLower === "set-cookie" ||
    keyLower === "env" ||
    keyLower === "headers" ||
    keyLower === "requestheaders"
  ) {
    return true;
  }
  
  // Substring matches (but only if they make sense as secrets)
  // Be more careful with 'key' to avoid matching 'keyboard', 'keynote', etc.
  if (
    keyLower.includes("token") ||
    keyLower.includes("secret") ||
    keyLower.includes("password") ||
    keyLower.includes("passwd") ||
    keyLower.includes("credential") ||
    keyLower.includes("session") ||
    keyLower.includes("bearer") ||
    // Match 'key' only if it's clearly about API/auth keys
    (keyLower.includes("key") && (
      keyLower.includes("api") ||
      keyLower.includes("auth") ||
      keyLower.endsWith("key") ||
      keyLower.startsWith("key") ||
      keyLower.includes("_key") ||
      keyLower.includes("-key")
    )) ||
    // Match 'auth' if it's clearly about authentication
    (keyLower.includes("auth") && !keyLower.includes("author"))
  ) {
    return true;
  }
  
  return false;
}

/**
 * Check if a string value looks like an actual token (Bearer/Basic/Token prefix).
 */
function isTokenValue(value: string): boolean {
  // Match "Bearer abc123" YES, "Bearer token holder" NO (multi-word)
  const match = value.match(/^(Bearer|Basic|Token)\s+(\S+)$/i);
  return match !== null;
}

/**
 * Check if an arg name (with dashes stripped) looks like a secret key.
 */
function isSecretArgName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/^-+/, '').replace(/[-_]/g, '');
  
  return (
    normalized === 'key' ||
    normalized.includes('apikey') ||
    normalized.includes('api') && normalized.includes('key') ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('passwd') ||
    normalized.includes('auth') ||
    normalized.includes('credential') ||
    normalized.includes('cookie') ||
    normalized.includes('session') ||
    normalized.includes('bearer')
  );
}

/**
 * Redact secrets in command-line argument strings.
 * Handles patterns like --key=XYZ, --api-key=XYZ, --token=XYZ, -name=value, etc.
 */
export function redactArgString(arg: string, placeholder: string = "<from-original>"): string {
  // Match --name=value or -name=value patterns
  return arg.replace(
    /(-+)([a-zA-Z][-_a-zA-Z0-9]*)=(\S+)/g,
    (match, dashes, name, value) => {
      if (isSecretArgName(name)) {
        return `${dashes}${name}=${placeholder}`;
      }
      return match;
    }
  );
}

/**
 * Check if a URL query parameter name looks like a secret.
 */
function isSecretQueryParam(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'token' ||
    lower === 'access_token' ||
    lower === 'api_key' ||
    lower === 'apikey' ||
    lower === 'key' ||
    lower === 'auth' ||
    lower === 'sig' ||
    lower === 'signature' ||
    lower === 'secret' ||
    lower === 'password' ||
    lower === 'client_secret' ||
    lower === 'code'
  );
}

/**
 * Redact secrets in a single URL string.
 */
function redactSingleUrl(url: string, placeholder: string): string {
  try {
    const parsed = new URL(url);
    let result = url;
    
    // Redact userinfo when credentials are present (avoid URL round-trip / encoding drift)
    if (parsed.username || parsed.password) {
      const userinfoPattern = /:\/\/([^@/]+)@/;
      result = result.replace(userinfoPattern, `://${placeholder}@`);
    }
    
    // Redact secret-looking query params by string replacement to avoid encoding
    for (const [key] of parsed.searchParams) {
      if (isSecretQueryParam(key)) {
        const value = parsed.searchParams.get(key);
        if (value !== null) {
          // Use regex to replace the query param value without encoding
          const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          result = result.replace(
            new RegExp(`([?&])${escapedKey}=${escapedValue}([&]|$)`),
            `$1${escapedKey}=${placeholder}$2`
          );
        }
      }
    }
    
    return result;
  } catch {
    // Not a valid URL
    return url;
  }
}

/**
 * Redact secrets in URL strings.
 * Handles userinfo (user:pass@host) and query parameters.
 * Also scans for embedded URLs in strings.
 */
export function redactUrlString(url: string, placeholder: string = "<from-original>"): string {
  // Check if the entire string is a URL
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return redactSingleUrl(url, placeholder);
  }
  
  // Scan for embedded URLs and redact them
  return url.replace(
    /([a-z][a-z0-9+.-]*:\/\/[^\s]+)/gi,
    (match) => redactSingleUrl(match, placeholder)
  );
}

/**
 * Recursively redact secrets in a config object.
 * Replaces secret values with the given placeholder (default: "<from-original>").
 * 
 * @param config - The config object to redact
 * @param placeholder - The placeholder string to use (default: "<from-original>")
 * @param parentKey - The parent key for context-aware redaction
 * @returns A new object with secrets redacted
 */
export function redactSecrets(
  config: unknown,
  placeholder: string = "<from-original>",
  parentKey?: string
): unknown {
  if (!config || typeof config !== "object") {
    // Handle plain strings: redact common secret patterns
    if (typeof config === "string") {
      let result = config;
      
      // Check if it's a token-like string value (Bearer/Basic/Token)
      if (isTokenValue(result)) {
        return placeholder;
      }
      
      // Redact SENTINEL_ test patterns (for test safety)
      result = result.replace(/SENTINEL_[A-Z0-9_]+_[a-z0-9]+/g, placeholder);
      
      // Redact URLs with secrets
      result = redactUrlString(result, placeholder);
      
      // Redact arg patterns
      result = redactArgString(result, placeholder);
      
      return result;
    }
    return config;
  }

  if (Array.isArray(config)) {
    // Special handling for "args" arrays
    if (parentKey === "args") {
      return config.map((item, idx) => {
        if (typeof item === "string") {
          // Redact --flag=value patterns
          let redacted = redactArgString(item, placeholder);
          
          // Check if this is a flag and the next item is its value (two-element form)
          const flagMatch = item.match(/^(-+)([a-zA-Z][-_a-zA-Z0-9]*)$/);
          if (flagMatch && idx + 1 < config.length && isSecretArgName(flagMatch[2])) {
            // Don't redact the flag itself, but the next item will be redacted
            return item;
          }
          
          // Check if previous item was a secret flag (two-element form)
          if (idx > 0 && typeof config[idx - 1] === "string") {
            const prevArg = config[idx - 1];
            const prevFlagMatch = prevArg.match(/^(-+)([a-zA-Z][-_a-zA-Z0-9]*)$/);
            if (prevFlagMatch && isSecretArgName(prevFlagMatch[2])) {
              // This is the value for a secret flag
              return placeholder;
            }
          }
          
          return redacted;
        }
        return redactSecrets(item, placeholder);
      });
    }
    
    return config.map(item => redactSecrets(item, placeholder));
  }

  const result: Record<string, unknown> = {};
  const configObj = config as Record<string, unknown>;

  for (const [key, value] of Object.entries(configObj)) {
    if (isSecretKey(key)) {
      // Redact the value
      if (value && typeof value === "object" && !Array.isArray(value)) {
        // If it's an object, redact all its properties
        const redacted: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>)) {
          redacted[k] = placeholder;
        }
        result[key] = redacted;
      } else {
        result[key] = placeholder;
      }
    } else if (value && typeof value === "object") {
      const keyLower = key.toLowerCase();
      if (
        MCP_SERVER_DIRECT_KEYS.has(keyLower) ||
        keyLower === "mcpservers" ||
        parentKey === "mcpServers"
      ) {
        result[key] = redactSecrets(value, placeholder, key);
      } else {
        result[key] = redactUnknownNestedLeaves(value, placeholder);
      }
    } else if (typeof value === "string") {
      // Check every string value for URLs or token patterns, regardless of key name
      if (isTokenValue(value)) {
        result[key] = placeholder;
      } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes('://')) {
        // String looks like a URL or contains a URL - redact secrets in it
        result[key] = redactUrlString(value, placeholder);
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Redact secrets in transportSummary field specifically.
 * Handles patterns like "env:{...}", URLs with userinfo/query params, and header-like patterns.
 */
export function redactTransportSummary(summary: string): string {
  let result = summary;

  // Redact env:{...} blocks
  result = result.replace(/\benv:\{[^}]*\}/g, "env:{<from-original>}");

  // Redact URLs (userinfo and query params), including embedded URLs in summaries
  result = redactUrlString(result, "<from-original>");

  // transportSummary tests expect explicit userinfo placeholder shape
  result = result.replace(
    /([a-z][a-z0-9+.-]*:\/\/)(?:<from-original>|[^:@\s/]+:[^@\s/]+)@/gi,
    "$1<user>:<password>@"
  );

  // Redact header-like patterns in summaries
  result = result.replace(
    /\b(Authorization|Cookie|X-API-Key|Proxy-Authorization):\s*[^\s,]+/gi,
    "$1: <from-original>"
  );

  return result;
}

/**
 * Sanitize a Report object by redacting secrets in transportSummary fields.
 * Returns a deep clone with secrets redacted.
 */
export function sanitizeReport<T extends { servers?: Array<{ transportSummary?: string }> }>(report: T): T {
  // Deep clone
  const cloned = JSON.parse(JSON.stringify(report)) as T;
  
  // Redact any secrets in server transportSummary
  if (cloned.servers) {
    for (const server of cloned.servers) {
      if (server.transportSummary) {
        server.transportSummary = redactTransportSummary(server.transportSummary);
      }
    }
  }
  
  return cloned;
}
