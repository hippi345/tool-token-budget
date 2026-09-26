import { describe, it, expect } from "vitest";
import path from "node:path";
import { isPathContainedIn } from "../src/utils/pathContainment.js";

describe("path containment with injected case sensitivity", () => {
  it("pr20-item07 / pr20-r2-item01 POSIX path module case sensitivity", () => {
    const parent = "/tmp/ParentDir";
    const child = "/tmp/parentdir/nested/file.txt";
    const posix = { caseInsensitive: true, pathModule: path.posix };
    const posixSensitive = { caseInsensitive: false, pathModule: path.posix };
    expect(isPathContainedIn(child, parent, posix)).toBe(true);
    expect(isPathContainedIn(child, parent, posixSensitive)).toBe(false);
  });
});
