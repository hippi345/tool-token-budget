import path from "node:path";
import { isPathContainedIn } from "./pathContainment.js";

type PathLike = Pick<typeof path, "resolve" | "join" | "relative" | "isAbsolute">;

function isStrictlyUnder(
  parent: string,
  child: string,
  pathImpl: PathLike
): boolean {
  const rel = pathImpl.relative(pathImpl.resolve(parent), pathImpl.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !pathImpl.isAbsolute(rel);
}

/**
 * True when an e2e fake HOME could overwrite the user's real Cursor config.
 * Temp dirs under the user profile (outside `.cursor`) are allowed.
 */
export function isDangerousTestHome(
  testHome: string,
  realHome: string,
  pathImpl: PathLike = path
): boolean {
  const resolvedTestHome = pathImpl.resolve(testHome);
  const resolvedRealHome = pathImpl.resolve(realHome);
  const realHomeCursor = pathImpl.join(resolvedRealHome, ".cursor");

  if (resolvedTestHome === resolvedRealHome || resolvedTestHome === realHomeCursor) {
    return true;
  }

  if (isStrictlyUnder(realHomeCursor, resolvedTestHome, pathImpl)) {
    return true;
  }

  if (isStrictlyUnder(resolvedTestHome, resolvedRealHome, pathImpl)) {
    return true;
  }

  if (isStrictlyUnder(resolvedTestHome, realHomeCursor, pathImpl)) {
    return true;
  }

  return false;
}

export interface TestIsolationPathCheck {
  isolatedHome: string;
  realHome: string;
  cwd: string;
  /** Use path.win32 in unit tests that simulate Windows layouts on Linux CI. */
  pathModule?: typeof path;
}

/**
 * Vitest guard: client config paths must live in the per-worker isolated HOME
 * or in the repo cwd (project-scoped configs). Rejects paths under the real
 * profile that are outside the isolated sandbox (substring checks are wrong
 * when the checkout or temp dir sits under the real home).
 */
export function isAllowedClientConfigPathForTestIsolation(
  clientPath: string,
  opts: TestIsolationPathCheck
): boolean {
  const pathImpl = opts.pathModule ?? path;
  const resolved = pathImpl.resolve(clientPath);
  const isolated = pathImpl.resolve(opts.isolatedHome);
  const real = pathImpl.resolve(opts.realHome);
  const cwd = pathImpl.resolve(opts.cwd);

  if (isPathContainedIn(resolved, isolated, { pathModule: pathImpl })) {
    return true;
  }
  if (isPathContainedIn(resolved, cwd, { pathModule: pathImpl })) {
    return true;
  }
  if (isPathContainedIn(resolved, real, { pathModule: pathImpl })) {
    return false;
  }
  return true;
}

export function assertClientConfigPathsIsolated(
  clientPaths: string[],
  opts: TestIsolationPathCheck
): void {
  for (const clientPath of clientPaths) {
    if (!isAllowedClientConfigPathForTestIsolation(clientPath, opts)) {
      throw new Error(
        `Client config path resolves under real home outside isolated test HOME: ${clientPath}`
      );
    }
  }
}
