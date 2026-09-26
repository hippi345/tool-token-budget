import type { ChildProcess } from "node:child_process";
import type { ServerInstance } from "../../src/ui/server.js";
import { pollUntil } from "../poll-until.js";

export function serverOrigin(server: ServerInstance): string {
  const u = new URL(server.url);
  return u.origin;
}

export function apiPost(
  server: ServerInstance,
  apiPath: string,
  body: unknown
): Promise<Response> {
  const origin = serverOrigin(server);
  return fetch(`${origin}${apiPath}`, {
    method: "POST",
    headers: {
      "X-Auth-Token": server.token,
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify(body),
  });
}

export function apiGet(server: ServerInstance, apiPath: string): Promise<Response> {
  const origin = serverOrigin(server);
  return fetch(`${origin}${apiPath}`, {
    headers: { "X-Auth-Token": server.token },
  });
}

export async function waitForServerHealthy(server: ServerInstance): Promise<void> {
  const origin = serverOrigin(server);
  await pollUntil(async () => {
    try {
      const res = await fetch(`${origin}/api/health`, {
        headers: { "X-Auth-Token": server.token },
      });
      return res.ok;
    } catch {
      return false;
    }
  }, { label: "UI server health", timeoutMs: 15_000 });
}

export async function closeServer(server: ServerInstance | undefined): Promise<void> {
  if (server) {
    await server.close();
  }
}

export async function killChildProcess(
  proc: ChildProcess | undefined,
  graceMs = 3_000
): Promise<void> {
  if (!proc || proc.killed || proc.exitCode !== null) {
    return;
  }
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    proc.once("exit", done);
    setTimeout(done, graceMs);
  });
  if (proc.exitCode === null && !proc.killed) {
    proc.kill("SIGKILL");
  }
}
