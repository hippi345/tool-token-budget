import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { isPathContainedIn } from "../../src/utils/pathContainment.js";
import {
  assertClientConfigPathsIsolated,
  isAllowedClientConfigPathForTestIsolation,
} from "../../src/utils/testHomeGuard.js";
import { detectClientConfigs } from "../../src/discover/clientConfigs.js";

describe("Home directory isolation guard", () => {
  it("uses isolated HOME and never resolves client configs under the real user home", async () => {
    const realHome = process.env.__TEST_REAL_HOME || process.env.REAL_HOME;
    const isolatedHome = process.env.__TEST_ISOLATED_HOME;
    expect(realHome, "homeIsolation setup must set REAL_HOME").toBeTruthy();
    expect(isolatedHome, "homeIsolation setup must set __TEST_ISOLATED_HOME").toBeTruthy();

    const currentHome = path.resolve(os.homedir());
    expect(path.normalize(currentHome)).not.toBe(path.normalize(realHome));
    expect(isPathContainedIn(currentHome, isolatedHome!)).toBe(true);

    const clients = await detectClientConfigs(process.cwd());
    assertClientConfigPathsIsolated(
      clients.map((c) => c.path),
      {
        isolatedHome: isolatedHome!,
        realHome: realHome!,
        cwd: process.cwd(),
      }
    );
  });
});

describe("isAllowedClientConfigPathForTestIsolation", () => {
  it("allows isolated sandbox paths even when real home is a prefix of the checkout", () => {
    const realHome = "/home/runner";
    const checkout = "/home/runner/work/tool-token-budget/tool-token-budget";
    const isolatedRoot = path.join("/tmp", "tool-token-budget-vitest-abc123");

    expect(
      isAllowedClientConfigPathForTestIsolation(
        path.join(isolatedRoot, ".cursor", "mcp.json"),
        { isolatedHome: isolatedRoot, realHome, cwd: checkout }
      )
    ).toBe(true);

    expect(
      isAllowedClientConfigPathForTestIsolation(path.join(checkout, ".cursor", "mcp.json"), {
        isolatedHome: isolatedRoot,
        realHome,
        cwd: checkout,
      })
    ).toBe(true);
  });

  it("rejects paths directly under the real profile outside the isolated root", () => {
    const realHome = "/home/runner";
    const checkout = "/home/runner/work/tool-token-budget/tool-token-budget";
    const isolatedRoot = path.join("/tmp", "tool-token-budget-vitest-abc123");

    expect(
      isAllowedClientConfigPathForTestIsolation(
        path.join(realHome, ".cursor", "mcp.json"),
        { isolatedHome: isolatedRoot, realHome, cwd: checkout }
      )
    ).toBe(false);

    expect(
      isAllowedClientConfigPathForTestIsolation(
        path.join(realHome, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
        { isolatedHome: isolatedRoot, realHome, cwd: checkout }
      )
    ).toBe(false);
  });

  it("allows Windows temp isolated home under USERPROFILE while blocking real profile configs", () => {
    const win32 = path.win32;
    const realHome = "C:\\Users\\runneradmin";
    const checkout = "C:\\Users\\runneradmin\\actions-runner\\work\\tool-token-budget\\tool-token-budget";
    const isolatedRoot =
      "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\tool-token-budget-vitest-xyz";

    expect(
      isAllowedClientConfigPathForTestIsolation(
        win32.join(isolatedRoot, ".cursor", "mcp.json"),
        { isolatedHome: isolatedRoot, realHome, cwd: checkout, pathModule: win32 }
      )
    ).toBe(true);

    expect(
      isAllowedClientConfigPathForTestIsolation(
        win32.join(realHome, ".cursor", "mcp.json"),
        { isolatedHome: isolatedRoot, realHome, cwd: checkout, pathModule: win32 }
      )
    ).toBe(false);
  });
});
