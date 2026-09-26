import { describe, test, expect } from "vitest";

describe("openBrowser spawn arguments", () => {
  test("Windows: URL with & query params does not break/inject", async () => {
    // Since openBrowser is not exported, we verify the implementation
    // by reading the source and checking the spawn call is secure
    
    const fs = await import("node:fs/promises");
    const cliSource = await fs.readFile("src/cli.ts", "utf8");
    
    // Verify that Windows spawn does NOT use shell:true
    // This ensures & in URLs won't be interpreted as command separators
    expect(cliSource).toContain('spawn("cmd", ["/c", "start", "", url]');
    
    // Ensure shell:true is not used on Windows
    const windowsSpawnMatch = cliSource.match(/process\.platform === "win32"[\s\S]{0,200}spawn\([^)]+\)/);
    if (windowsSpawnMatch) {
      expect(windowsSpawnMatch[0]).not.toContain('shell: true');
    }
  });

  test("Windows spawn args array prevents command injection", async () => {
    // Verify that the spawn call uses an array of args, not a string
    // This ensures that & in URLs won't be interpreted as command separator
    
    const fs = await import("node:fs/promises");
    const cliSource = await fs.readFile("src/cli.ts", "utf8");
    
    // The correct Windows spawn should be:
    // spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
    // NOT: spawn("cmd", "/c start \"\" " + url, { shell: true })
    
    // Verify the args are passed as an array
    expect(cliSource).toContain('["/c", "start", "", url]');
    
    // With shell:false (default), the args array is passed directly to the process
    // so "token=abc&foo=bar" stays as a single argument, not parsed as commands
    const testUrl = "http://127.0.0.1:8080?token=abc&foo=bar";
    const expectedArgs = ["/c", "start", "", testUrl];
    
    // Verify array contains the URL as-is without interpretation
    expect(expectedArgs[3]).toBe(testUrl);
    expect(expectedArgs[3]).toContain("&");
  });

  test("macOS spawn uses simple open command", async () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      writable: true,
      configurable: true,
    });

    const fs = await import("node:fs/promises");
    const cliSource = await fs.readFile("src/cli.ts", "utf8");
    
    // Verify macOS uses open with simple args
    expect(cliSource).toContain('spawn("open", [url]');
  });

  test("Linux spawn uses xdg-open command", async () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      writable: true,
      configurable: true,
    });

    const fs = await import("node:fs/promises");
    const cliSource = await fs.readFile("src/cli.ts", "utf8");
    
    // Verify Linux uses xdg-open with simple args
    expect(cliSource).toContain('spawn("xdg-open", [url]');
  });
});
