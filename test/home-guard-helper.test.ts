import { describe, it, expect } from "vitest";
import path from "node:path";
import { isDangerousTestHome } from "../src/utils/testHomeGuard.js";

describe("isDangerousTestHome", () => {
  describe("POSIX paths", () => {
    const posix = path.posix;

    it("detects when testHome equals realHome", () => {
      expect(isDangerousTestHome("/home/user", "/home/user")).toBe(true);
    });

    it("detects when testHome equals realHome/.cursor", () => {
      expect(isDangerousTestHome("/home/user/.cursor", "/home/user")).toBe(true);
    });

    it("detects when testHome is inside realHome/.cursor", () => {
      expect(isDangerousTestHome("/home/user/.cursor/test", "/home/user")).toBe(true);
    });

    it("detects when realHome is inside testHome", () => {
      expect(isDangerousTestHome("/tmp/test", "/tmp/test/fakehome")).toBe(true);
    });

    it("allows testHome in a separate top-level directory", () => {
      expect(isDangerousTestHome("/tmp/e2e-test-home", "/home/user")).toBe(false);
    });

    it("allows testHome under the user profile but outside .cursor", () => {
      expect(isDangerousTestHome("/home/user/projects/repo/tmp/e2e", "/home/user")).toBe(false);
    });
  });

  describe("Windows paths", () => {
    const win32 = path.win32;

    it("detects when testHome equals realHome (Windows-style paths)", () => {
      expect(isDangerousTestHome("C:\\Users\\testuser", "C:\\Users\\testuser", win32)).toBe(true);
    });

    it("detects when testHome equals realHome\\.cursor", () => {
      expect(isDangerousTestHome("C:\\Users\\testuser\\.cursor", "C:\\Users\\testuser", win32)).toBe(true);
    });

    it("allows AppData Local Temp e2e home under the profile", () => {
      expect(
        isDangerousTestHome(
          "C:\\Users\\testuser\\AppData\\Local\\Temp\\e2e-test-home-w0",
          "C:\\Users\\testuser",
          win32
        )
      ).toBe(false);
    });

    it("flags test home inside the real .cursor directory", () => {
      expect(
        isDangerousTestHome("C:\\Users\\testuser\\.cursor\\e2e-test", "C:\\Users\\testuser", win32)
      ).toBe(true);
    });
  });
});
