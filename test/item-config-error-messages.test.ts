import { describe, it, expect } from "vitest";
import { formatConfigLoadError } from "../src/config/formatConfigLoadError.js";

describe("config load error messages are meaningful and redacted", () => {
  it("unquoted JSON value yields a safe syntax message (not 'Un' or secret text)", () => {
    const raw =
      'Unexpected token \'Q\', ..."API_KEY": QZXW59hArg"... is not valid JSON at position 40 (line 3 column 18)';
    const msg = formatConfigLoadError(new Error(raw));
    expect(msg).toMatch(/JSON syntax error/);
    expect(msg).not.toBe("Un");
    expect(msg).not.toContain("QZXW59");
  });

  it("empty file yields empty-or-truncated message", () => {
    const msg = formatConfigLoadError(new Error("Unexpected end of JSON input"));
    expect(msg).toBe("Config file is empty or truncated");
  });

  it("partial JSON after atomic replace yields syntax line/column without snippet", () => {
    const raw =
      "Unexpected end of JSON input at position 12 (line 2 column 5)";
    const msg = formatConfigLoadError(new Error(raw));
    expect(msg).toMatch(/empty|truncated|line 2 column 5/i);
    expect(msg).not.toBe("Un");
  });
});
