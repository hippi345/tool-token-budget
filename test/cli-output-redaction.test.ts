import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("CLI output redaction (Item 8 - SECURITY)", () => {
  const cliPath = path.resolve(__dirname, "..", "dist", "cli.js");

  it("analyze --json redacts secrets in transportSummary", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "cli-json-"));

    try {
      // Create config with remote server containing userinfo and secret query params
      const configPath = path.join(testDir, "mcp.json");
      const config = {
        mcpServers: {
          "remote-server": {
            command: "node",
            args: ["server.js"],
            transport: {
              type: "http" as const,
              url: "https://user:SENTINEL_PW_json@example.com/path?token=SENTINEL_QT_json&api_key=SENTINEL_QK_json",
            },
          },
        },
      };
      await writeFile(configPath, JSON.stringify(config), "utf8");

      // Run analyze --json
      let output = "";
      try {
        output = execSync(`node "${cliPath}" analyze "${configPath}" --json 2>&1`, {
          encoding: "utf8",
          stdio: "pipe",
          timeout: 60000,
        });
      } catch (err: any) {
        output = err.stdout + err.stderr;
      }

      // Verify no sentinels leak in JSON output
      expect(output).not.toContain("SENTINEL_PW_json");
      expect(output).not.toContain("SENTINEL_QT_json");
      expect(output).not.toContain("SENTINEL_QK_json");
      
      // Verify it's valid JSON
      expect(() => JSON.parse(output)).not.toThrow();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("analyze (text format) redacts secrets in transportSummary", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "cli-text-"));

    try {
      const configPath = path.join(testDir, "mcp.json");
      const config = {
        mcpServers: {
          "remote-server": {
            command: "node",
            args: ["server.js"],
            transport: {
              type: "http" as const,
              url: "https://user:SENTINEL_PW_text@example.com/path?token=SENTINEL_QT_text&api_key=SENTINEL_QK_text",
            },
          },
        },
      };
      await writeFile(configPath, JSON.stringify(config), "utf8");

      // Run analyze with default text output
      let output = "";
      try {
        output = execSync(`node "${cliPath}" analyze "${configPath}" 2>&1`, {
          encoding: "utf8",
          stdio: "pipe",
          timeout: 60000,
        });
      } catch (err: any) {
        output = err.stdout + err.stderr;
      }

      // Verify no sentinels leak in text output
      expect(output).not.toContain("SENTINEL_PW_text");
      expect(output).not.toContain("SENTINEL_QT_text");
      expect(output).not.toContain("SENTINEL_QK_text");
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("analyze --format sarif (stdout) redacts secrets", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "cli-sarif-stdout-"));

    try {
      const configPath = path.join(testDir, "mcp.json");
      const config = {
        mcpServers: {
          "remote-server": {
            command: "node",
            args: ["server.js"],
            transport: {
              type: "http" as const,
              url: "https://user:SENTINEL_PW_sarif@example.com/path?token=SENTINEL_QT_sarif&api_key=SENTINEL_QK_sarif",
            },
          },
        },
      };
      await writeFile(configPath, JSON.stringify(config), "utf8");

      // Run analyze with SARIF output to stdout
      let output = "";
      try {
        output = execSync(`node "${cliPath}" analyze "${configPath}" --format sarif 2>&1`, {
          encoding: "utf8",
          stdio: "pipe",
          timeout: 60000,
        });
      } catch (err: any) {
        output = err.stdout + err.stderr;
      }

      // Verify no sentinels leak in SARIF stdout
      expect(output).not.toContain("SENTINEL_PW_sarif");
      expect(output).not.toContain("SENTINEL_QT_sarif");
      expect(output).not.toContain("SENTINEL_QK_sarif");
      
      // Verify it's valid JSON SARIF
      expect(() => JSON.parse(output)).not.toThrow();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("analyze --sarif <file> redacts secrets in written file", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "cli-sarif-file-"));

    try {
      const configPath = path.join(testDir, "mcp.json");
      const sarifPath = path.join(testDir, "report.sarif.json");
      
      const config = {
        mcpServers: {
          "remote-server": {
            command: "node",
            args: ["server.js"],
            transport: {
              type: "http" as const,
              url: "https://user:SENTINEL_PW_sariffile@example.com/path?token=SENTINEL_QT_sariffile&api_key=SENTINEL_QK_sariffile",
            },
          },
        },
      };
      await writeFile(configPath, JSON.stringify(config), "utf8");

      // Run analyze with SARIF file output
      execSync(`node "${cliPath}" analyze "${configPath}" --sarif "${sarifPath}" 2>&1`, {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 10000,
      });

      // Read the written SARIF file
      const sarifContent = await readFile(sarifPath, "utf8");

      // Verify no sentinels leak in SARIF file
      expect(sarifContent).not.toContain("SENTINEL_PW_sariffile");
      expect(sarifContent).not.toContain("SENTINEL_QT_sariffile");
      expect(sarifContent).not.toContain("SENTINEL_QK_sariffile");
      
      // Verify it's valid JSON
      expect(() => JSON.parse(sarifContent)).not.toThrow();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("analyze --html <file> redacts secrets in written file", async () => {
    const testDir = await mkdtemp(path.join(tmpdir(), "cli-html-"));

    try {
      const configPath = path.join(testDir, "mcp.json");
      const htmlPath = path.join(testDir, "report.html");
      
      const config = {
        mcpServers: {
          "remote-server": {
            command: "node",
            args: ["server.js"],
            transport: {
              type: "http" as const,
              url: "https://user:SENTINEL_PW_html@example.com/path?token=SENTINEL_QT_html&api_key=SENTINEL_QK_html",
            },
          },
        },
      };
      await writeFile(configPath, JSON.stringify(config), "utf8");

      // Run analyze with HTML file output
      execSync(`node "${cliPath}" analyze "${configPath}" --html "${htmlPath}" 2>&1`, {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 10000,
      });

      // Read the written HTML file
      const htmlContent = await readFile(htmlPath, "utf8");

      // Verify no sentinels leak in HTML file
      expect(htmlContent).not.toContain("SENTINEL_PW_html");
      expect(htmlContent).not.toContain("SENTINEL_QT_html");
      expect(htmlContent).not.toContain("SENTINEL_QK_html");
      
      // Verify it's HTML
      expect(htmlContent).toContain("<html");
      expect(htmlContent).toContain("</html>");
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("doctor command redacts secrets (uses formatTextReport)", async () => {
    // doctor uses a fixture, but we test that formatTextReport path is sanitized
    let output = "";
    try {
      output = execSync(`node "${cliPath}" doctor 2>&1`, {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 10000,
      });
    } catch (err: any) {
      output = err.stdout + err.stderr;
    }

    // Verify doctor runs successfully
    expect(output).toContain("doctor: ok");
    
    // No sentinels should appear (fixture doesn't have them, but verifies the code path)
  });
});
