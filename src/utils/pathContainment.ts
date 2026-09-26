import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolves a path to its canonical form, handling symlinks, junctions, and case.
 * For nonexistent paths, resolves the nearest existing ancestor and appends the rest.
 */
function resolveCanonicalNative(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) {
      return p;
    }
    const resolvedParent = resolveCanonicalNative(parent);
    const relative = path.basename(p);
    return path.join(resolvedParent, relative);
  }
}

function normalizeForContainment(
  p: string,
  pathImpl: typeof path,
  useNativeRealpath: boolean
): string {
  const resolved = pathImpl.resolve(p);
  if (useNativeRealpath) {
    return resolveCanonicalNative(path.resolve(p));
  }
  return resolved;
}

/**
 * Returns true if `child` is inside `parent` or equal to `parent`.
 * Uses canonical path resolution (symlinks, junctions, case-insensitive on Windows/macOS).
 * Safe against: case variants, prefix siblings (/a/bc vs /a/b), symlinks, 8.3 short names.
 */
export function isPathContainedIn(
  child: string,
  parent: string,
  options?: {
    caseInsensitive?: boolean;
    /** Override path module (e.g. path.posix) for deterministic tests on Windows. */
    pathModule?: typeof path;
  }
): boolean {
  const pathImpl = options?.pathModule ?? path;
  const useNativeRealpath = pathImpl === path && options?.pathModule === undefined;

  const canonicalChild = normalizeForContainment(child, pathImpl, useNativeRealpath);
  const canonicalParent = normalizeForContainment(parent, pathImpl, useNativeRealpath);

  if (canonicalChild === canonicalParent) {
    return true;
  }

  const caseInsensitive =
    options?.caseInsensitive ??
    (process.platform === "win32" || process.platform === "darwin");
  const childNorm = caseInsensitive ? canonicalChild.toLowerCase() : canonicalChild;
  const parentNorm = caseInsensitive ? canonicalParent.toLowerCase() : canonicalParent;

  if (childNorm === parentNorm) {
    return true;
  }

  const rel = pathImpl.relative(parentNorm, childNorm);

  return rel !== "" && !rel.startsWith("..") && !pathImpl.isAbsolute(rel);
}

/**
 * Returns true if `child` is inside ANY of the `parents` directories.
 */
export function isPathContainedInAny(child: string, parents: string[]): boolean {
  return parents.some((parent) => isPathContainedIn(child, parent));
}
