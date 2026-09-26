import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { pollUntil } from "../poll-until.js";
import { killChildProcess } from "./uiServer.js";

const URL_RE = /http:\/\/127\.0\.0\.1:\d+\?token=[a-f0-9]+/;

export interface UiCliServerHandle {
  proc: ChildProcess;
  serverUrl: string;
  origin: string;
  token: string;
  stop: () => Promise<void>;
}

export async function startUiCliServer(opts: {
  cliPath: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}): Promise<UiCliServerHandle> {
  const proc = spawn("node", [opts.cliPath, ...opts.args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let capturedUrl = "";
  let stdoutBuf = "";
  proc.stdout?.on("data", (d) => {
    stdoutBuf += d.toString();
    const m = stdoutBuf.match(URL_RE);
    if (m) {
      capturedUrl = m[0];
    }
  });

  await pollUntil(
    async () => {
      if (capturedUrl) return true;
      if (proc.exitCode !== null) {
        throw new Error(`UI CLI exited early with code ${proc.exitCode}`);
      }
      return false;
    },
    { timeoutMs: 30_000, label: "UI CLI server URL on stdout" }
  );

  const serverUrl = capturedUrl;
  const origin = new URL(serverUrl).origin;
  const token = new URL(serverUrl).searchParams.get("token") ?? "";

  return {
    proc,
    serverUrl,
    origin,
    token,
    stop: async () => {
      await killChildProcess(proc);
    },
  };
}

export function repoCliPath(repoRoot: string): string {
  return path.join(repoRoot, "dist", "cli.js");
}
