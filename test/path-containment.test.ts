import { describe, it, expect } from "vitest";
import { isPathContainedIn, isPathContainedInAny } from "../src/utils/pathContainment.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Path containment helper (Item 2)", () => {
  it("detects exact equality", () => {
    const dir = path.resolve(__dirname, "fixtures");
    expect(isPathContainedIn(dir, dir)).toBe(true);
  });

  it("detects nested child", () => {
    const parent = path.resolve(__dirname, "fixtures");
    const child = path.join(parent, "subfolder", "file.txt");
    expect(isPathContainedIn(child, parent)).toBe(true);
  });

  it("rejects prefix sibling (/a/bc vs /a/b)", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "path-test-"));
    try {
      const dirA = path.join(tmpBase, "a");
      const dirB = path.join(tmpBase, "ab");
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });
      
      const childInB = path.join(dirB, "file.txt");
      expect(isPathContainedIn(childInB, dirA)).toBe(false);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("handles case-insensitive on Windows/macOS", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "case-test-"));
    try {
      const dir = path.join(tmpBase, "MyFolder");
      fs.mkdirSync(dir, { recursive: true });
      
      const childLower = path.join(tmpBase, "myfolder", "file.txt");
      const childUpper = path.join(tmpBase, "MYFOLDER", "file.txt");
      
      if (process.platform === "win32" || process.platform === "darwin") {
        expect(isPathContainedIn(childLower, dir)).toBe(true);
        expect(isPathContainedIn(childUpper, dir)).toBe(true);
      } else {
        // On Linux, case matters
        expect(isPathContainedIn(childLower, dir)).toBe(false);
        expect(isPathContainedIn(childUpper, dir)).toBe(false);
      }
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("handles nonexistent target paths", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "nonexist-test-"));
    try {
      const parent = path.join(tmpBase, "parent");
      fs.mkdirSync(parent, { recursive: true });
      
      const nonexistentChild = path.join(parent, "does-not-exist", "file.txt");
      expect(isPathContainedIn(nonexistentChild, parent)).toBe(true);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("handles symlinks (skip on Windows if creation fails)", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "symlink-test-"));
    try {
      const realDir = path.join(tmpBase, "real");
      const linkDir = path.join(tmpBase, "link");
      fs.mkdirSync(realDir, { recursive: true });
      
      try {
        fs.symlinkSync(realDir, linkDir, "dir");
        
        const childViaLink = path.join(linkDir, "file.txt");
        const childViaReal = path.join(realDir, "file.txt");
        
        // Both should be contained in realDir (canonical resolution)
        expect(isPathContainedIn(childViaLink, realDir)).toBe(true);
        expect(isPathContainedIn(childViaReal, realDir)).toBe(true);
      } catch (err: any) {
        if (process.platform === "win32" && err.code === "EPERM") {
          expect(err.code).toBe("EPERM");
        } else {
          throw err;
        }
      }
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("isPathContainedInAny checks multiple parents", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "multi-test-"));
    try {
      const dir1 = path.join(tmpBase, "dir1");
      const dir2 = path.join(tmpBase, "dir2");
      fs.mkdirSync(dir1, { recursive: true });
      fs.mkdirSync(dir2, { recursive: true });
      
      const childInDir2 = path.join(dir2, "file.txt");
      expect(isPathContainedInAny(childInDir2, [dir1, dir2])).toBe(true);
      expect(isPathContainedInAny(childInDir2, [dir1])).toBe(false);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
