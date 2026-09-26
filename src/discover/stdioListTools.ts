import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ServerStatus, Tool } from "../types.js";
import { classifyStdioConnectFailure } from "./spawnError.js";
import { attachStdioProcessDiagnostics } from "./stdioDiagnostics.js";

export interface StdioServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ListToolsResult {
  tools: Tool[];
  status: ServerStatus;
  error?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** Spawn stdio MCP server, list tools, shut down. Isolates failures. */
export async function listToolsStdio(
  server: StdioServerSpec,
  timeoutMs = 15_000
): Promise<ListToolsResult> {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    stderr: "pipe",
  });
  const client = new Client({ name: "tool-token-budget", version: "1.0.0" });
  const diagnostics = attachStdioProcessDiagnostics(transport);

  try {
    await withTimeout(client.connect(transport), timeoutMs, "handshake");
  } catch (err) {
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
    await diagnostics.waitForExit();
    const msg = err instanceof Error ? err.message : String(err);
    const status = classifyStdioConnectFailure(msg, {
      stderr: diagnostics.getStderr(),
      exitCode: diagnostics.getExitCode(),
      signal: diagnostics.getSignal(),
      sawStdout: diagnostics.sawStdout(),
    });
    const detail = diagnostics.getStderr().trim();
    const error = detail ? `${msg} | stderr: ${detail}` : msg;
    return { tools: [], status, error };
  }

  try {
    const result = await withTimeout(client.listTools(), timeoutMs, "tools/list");
    const tools: Tool[] = (result.tools ?? []).map((t) => ({
      server: server.name,
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      annotations: t.annotations as Record<string, unknown> | undefined,
    }));
    await client.close();
    return { tools, status: "ok" };
  } catch (err) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    const msg = err instanceof Error ? err.message : String(err);
    const status: ServerStatus = msg.includes("timed out")
      ? "timed_out"
      : "tools_list_failed";
    return { tools: [], status, error: msg };
  }
}
