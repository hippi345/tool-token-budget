import path from "node:path";

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
