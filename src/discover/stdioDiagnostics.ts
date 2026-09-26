import type { ChildProcess } from "node:child_process";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const STDERR_CAP = 8192;

export interface StdioProcessDiagnostics {
  getStderr: () => string;
  getExitCode: () => number | null;
  getSignal: () => NodeJS.Signals | null;
  sawStdout: () => boolean;
  waitForExit: (ms?: number) => Promise<void>;
}

export function attachStdioProcessDiagnostics(
  transport: StdioClientTransport
): StdioProcessDiagnostics {
  const stderrParts: string[] = [];
  let stderrLen = 0;
  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrLen += text.length;
      stderrParts.push(text);
      while (stderrLen > STDERR_CAP && stderrParts.length > 0) {
        const dropped = stderrParts.shift()!;
        stderrLen -= dropped.length;
      }
    });
  }

  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let sawStdoutBytes = false;

  const bindProcess = (proc: ChildProcess) => {
    if (proc.stdout && proc.stdout.listenerCount("data") === 0) {
      proc.stdout.on("data", () => {
        sawStdoutBytes = true;
      });
    }
    if (proc.listenerCount("close") === 0) {
      proc.once("close", (code, sig) => {
        exitCode = code;
        signal = sig;
      });
    }
  };

  const getProcess = (): ChildProcess | undefined =>
    (transport as unknown as { _process?: ChildProcess })._process;

  if (getProcess()) {
    bindProcess(getProcess()!);
  }

  const waitForExit = async (ms = 2000): Promise<void> => {
    const proc = getProcess();
    if (proc) {
      bindProcess(proc);
    }
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (exitCode !== null) {
        return;
      }
      const p = getProcess();
      if (p?.exitCode !== null && p?.exitCode !== undefined) {
        exitCode = p.exitCode;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  return {
    getStderr: () => stderrParts.join(""),
    sawStdout: () => sawStdoutBytes,
    getExitCode: () => {
      if (exitCode !== null) {
        return exitCode;
      }
      const p = getProcess();
      return p?.exitCode ?? null;
    },
    getSignal: () => signal,
    waitForExit,
  };
}
