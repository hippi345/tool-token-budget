import { describe, it, expect } from "vitest";
import {
  DISCOVERY_LOADING_MESSAGE,
  formatApiError,
  isRetryableDiscoveryStatus,
} from "../gui/src/httpErrors.js";

describe("item 22: friendly API error formatting", () => {
  it("maps discovery 503 JSON to a friendly message", () => {
    const body = JSON.stringify({
      error: "Discovery in progress; retry preview/apply in a few seconds",
    });
    expect(formatApiError(503, body)).toBe(DISCOVERY_LOADING_MESSAGE);
    expect(formatApiError(503, body)).not.toContain("{");
  });

  it("extracts plain error field from JSON without showing raw object", () => {
    expect(formatApiError(409, JSON.stringify({ error: "Conflict: hash mismatch" }))).toBe(
      "Conflict: hash mismatch"
    );
  });

  it("treats discovery 503 as retryable", () => {
    const body = JSON.stringify({ error: "Discovery in progress" });
    expect(isRetryableDiscoveryStatus(503, body)).toBe(true);
    expect(isRetryableDiscoveryStatus(409, body)).toBe(false);
  });
});
