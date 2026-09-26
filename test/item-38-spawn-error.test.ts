import { describe, it, expect } from "vitest";
import { classifyStdioConnectFailure } from "../src/discover/spawnError.js";

describe("item 38: spawn vs handshake classification", () => {
  it("classifies POSIX ENOENT as spawn_failed", () => {
    expect(classifyStdioConnectFailure("spawn ENOENT")).toBe("spawn_failed");
  });

  it("classifies Windows 'is not recognized' as spawn_failed", () => {
    expect(
      classifyStdioConnectFailure("Process exited", {
        stderr: "'npx.cmd' is not recognized as an internal or external command",
        exitCode: 9009,
      })
    ).toBe("spawn_failed");
  });

  it("classifies exit code 127 as spawn_failed", () => {
    expect(classifyStdioConnectFailure("failed", { exitCode: 127, stderr: "not found" })).toBe(
      "spawn_failed"
    );
  });

  it("classifies handshake timeout separately", () => {
    expect(classifyStdioConnectFailure("handshake timed out after 15000ms")).toBe("timed_out");
  });

  it("classifies generic protocol errors as handshake_failed", () => {
    expect(classifyStdioConnectFailure("Invalid JSON-RPC response")).toBe("handshake_failed");
  });
});
