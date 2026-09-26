import { writeFile } from "node:fs/promises";
import path from "node:path";
import { computeConfigContentHash } from "../src/mcp/configGuards.js";

export async function writeAdjacentEmitReport(
  proposedPath: string,
  mcpConfigPath: string,
  removedServers: string[] = []
): Promise<void> {
  const content = await import("node:fs/promises").then((m) => m.readFile(mcpConfigPath, "utf8"));
  const reportPath = path.join(path.dirname(proposedPath), "report.json");
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        savings: { removedServers },
        sourceConfigHash: computeConfigContentHash(content),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}
