import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { detectClientConfigs } from "../../src/discover/clientConfigs.js";

describe("Home directory isolation guard", () => {
  it("uses isolated HOME and never resolves client configs under the real user home", async () => {
    const realHome = process.env.__TEST_REAL_HOME || process.env.REAL_HOME;
    expect(realHome, "homeIsolation setup must set REAL_HOME").toBeTruthy();
    const currentHome = os.homedir();

    expect(path.normalize(currentHome)).not.toBe(path.normalize(realHome));
    expect(path.normalize(currentHome)).toContain(
      path.normalize(path.join("tmp", "test-isolation"))
    );

    const normalizedRealHome = path.normalize(realHome);
    const clients = await detectClientConfigs(process.cwd());
    for (const client of clients) {
      const normalizedPath = path.normalize(client.path);
      expect(normalizedPath).not.toContain(normalizedRealHome);
    }
  });
});
