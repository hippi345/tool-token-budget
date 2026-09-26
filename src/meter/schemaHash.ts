import { createHash } from "node:crypto";

export function hashSchema(inputSchema: unknown): string {
  const json = JSON.stringify(inputSchema ?? {});
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}
