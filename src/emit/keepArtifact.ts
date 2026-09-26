import { access, readFile } from "node:fs/promises";
import path from "node:path";

/** Primary keep-list filename emitted since TTB stage 3a. */
export const TOOL_TOKEN_BUDGET_KEEP_FILENAME = "tool-token-budget.keep.json";

/** Legacy keep-list filename (still read for back-compat). */
export const LEGACY_KEEP_FILENAME = "schema-budget.keep.json";

export function keepProposalWritePath(outDir: string): string {
  return path.join(outDir, TOOL_TOKEN_BUDGET_KEEP_FILENAME);
}

/** Read keep proposal from outDir if either new or legacy filename exists. */
export async function readKeepProposalFromDir(
  outDir: string
): Promise<{ content: string; filename: string } | null> {
  for (const name of [TOOL_TOKEN_BUDGET_KEEP_FILENAME, LEGACY_KEEP_FILENAME]) {
    const p = path.join(outDir, name);
    try {
      await access(p);
      const content = await readFile(p, "utf8");
      return { content, filename: name };
    } catch {
      // try next
    }
  }
  return null;
}
