/** Default lint thresholds (documented in README). */
export const DESC_CHARS = 500;
export const SCHEMA_TOKENS = 800;
export const ENUM_LEN = 50;
export const MAX_DEPTH = 6;

/** Walk schema for enum arrays; return max enum length found. */
export function maxEnumLength(schema: unknown): number {
  let max = 0;
  function walk(node: unknown): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.enum)) {
      max = Math.max(max, obj.enum.length);
    }
    for (const v of Object.values(obj)) walk(v);
  }
  walk(schema);
  return max;
}

/**
 * Max nesting depth via properties/items.
 * Depth 0 = leaf or empty; each properties/items level increments.
 */
export function schemaDepth(schema: unknown): number {
  function depth(node: unknown): number {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return 0;
    }
    const obj = node as Record<string, unknown>;
    let maxChild = 0;
    if (obj.properties && typeof obj.properties === "object") {
      for (const child of Object.values(obj.properties as Record<string, unknown>)) {
        maxChild = Math.max(maxChild, 1 + depth(child));
      }
    }
    if (obj.items !== undefined) {
      maxChild = Math.max(maxChild, 1 + depth(obj.items));
    }
    return maxChild;
  }
  return depth(schema);
}
