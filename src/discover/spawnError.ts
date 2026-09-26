import type { ServerStatus } from "../types.js";

export interface StdioFailureHints {
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  /** True if the child wrote any bytes to stdout before failing. */
  sawStdout?: boolean;
}

/** Classify MCP stdio connect failures (spawn vs handshake vs timeout). */
export function classifyStdioConnectFailure(
  errMsg: string,
  hints?: StdioFailureHints
): ServerStatus {
  if (errMsg.includes("timed out")) {
    return "timed_out";
  }

  const stderr = hints?.stderr ?? "";
  const combined = `${errMsg}\n${stderr}`;
  const lower = combined.toLowerCase();
  const exitCode = hints?.exitCode;
  const sawStdout = hints?.sawStdout === true;

  const windowsMissingBinary =
    /\bthe system cannot find the (path|file) specified\.?\b/i.test(lower);

  const npmPackageMissing =
    /\bnpm (err!|error) code e404\b/i.test(lower) ||
    /\bnpm error 404\b/i.test(lower) ||
    (/404 not found/i.test(lower) && /npm/i.test(stderr));

  const notRecognizedCmd =
    /not recognized as an internal or external command/i.test(lower);

  const spawnFromLaunchWithoutStdout =
    !sawStdout &&
    (errMsg.includes("ENOENT") ||
      errMsg.includes("EACCES") ||
      lower.includes("enoent") ||
      lower.includes("eacces") ||
      exitCode === 9009 ||
      exitCode === 127 ||
      notRecognizedCmd ||
      windowsMissingBinary ||
      npmPackageMissing);

  if (spawnFromLaunchWithoutStdout) {
    return "spawn_failed";
  }

  if (exitCode !== null && exitCode !== undefined) {
    return "handshake_failed";
  }

  if (lower.includes("connection closed") || lower.includes("-32000")) {
    return "handshake_failed";
  }

  if (errMsg.toLowerCase().includes("spawn")) {
    return "spawn_failed";
  }

  return "handshake_failed";
}
