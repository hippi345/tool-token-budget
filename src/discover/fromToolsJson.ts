import { readFile } from "node:fs/promises";
import type { Server, Tool } from "../types.js";
import { parseJSON } from "../utils/json.js";

interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

interface RawServer {
  name: string;
  tools: RawTool[];
}

interface ToolsJsonFile {
  servers: RawServer[];
}

/** Load offline tools/list style fixture JSON. */
export async function loadToolsJson(
  path: string
): Promise<{ servers: Server[]; tools: Tool[] }> {
  const raw = parseJSON<ToolsJsonFile>(await readFile(path, "utf8"));
  if (!raw || !Array.isArray(raw.servers)) {
    throw new Error(`Invalid tools JSON at ${path}: expected { servers: [...] }`);
  }
  const servers: Server[] = [];
  const tools: Tool[] = [];
  for (const s of raw.servers) {
    servers.push({ name: s.name, status: "ok", transportSummary: "tools-json" });
    for (const t of s.tools ?? []) {
      tools.push({
        server: s.name,
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        annotations: t.annotations,
      });
    }
  }
  return { servers, tools };
}
