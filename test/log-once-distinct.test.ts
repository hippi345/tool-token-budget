import { describe, it, expect, beforeEach } from "vitest";
import { logOnce, resetLogOnceForTests } from "../src/config/logOnce.js";

describe("logOnce", () => {
  beforeEach(() => {
    resetLogOnceForTests();
  });

  it("logs once per identical line but again for a different error message", () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (line: string) => lines.push(line);
    try {
      logOnce("config-load-error", "Cannot load config (will retry): error A");
      logOnce("config-load-error", "Cannot load config (will retry): error A");
      logOnce("config-load-error", "Cannot load config (will retry): error B");
    } finally {
      console.error = orig;
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("error A");
    expect(lines[1]).toContain("error B");
  });
});
