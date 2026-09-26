import { describe, it, expect } from "vitest";
import { stripBOM, parseJSON } from "../src/utils/json.js";

describe("BOM handling", () => {
  it("stripBOM removes UTF-8 BOM", () => {
    const withBOM = "\uFEFF{\"test\": true}";
    const withoutBOM = "{\"test\": true}";
    
    expect(stripBOM(withBOM)).toBe(withoutBOM);
    expect(stripBOM(withoutBOM)).toBe(withoutBOM);
  });

  it("parseJSON handles content with BOM", () => {
    const withBOM = "\uFEFF{\"test\": true, \"value\": 123}";
    const withoutBOM = "{\"test\": true, \"value\": 123}";
    
    const result1 = parseJSON(withBOM);
    const result2 = parseJSON(withoutBOM);
    
    expect(result1).toEqual({ test: true, value: 123 });
    expect(result2).toEqual({ test: true, value: 123 });
  });

  it("parseJSON handles nested JSON with BOM", () => {
    const withBOM = "\uFEFF{\"mcpServers\": {\"test\": {\"command\": \"node\"}}}";
    const result = parseJSON(withBOM);
    
    expect(result).toEqual({
      mcpServers: {
        test: {
          command: "node"
        }
      }
    });
  });
});
