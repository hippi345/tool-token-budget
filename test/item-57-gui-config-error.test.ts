import { describe, it, expect } from "vitest";
import {
  formatApiError,
  isRetryableDiscoveryStatus,
  DISCOVERY_LOADING_MESSAGE,
} from "../gui/src/httpErrors.ts";
import { reconcileApplySectionOnConfigHealth } from "../gui/src/configHealthUi.ts";

describe("item 57: GUI config error handling", () => {
  it("does not retry or mask config-unreadable 503 bodies", () => {
    const body = "Config file cannot be read: JSON syntax error at line 2 column 3";
    expect(isRetryableDiscoveryStatus(503, body)).toBe(false);
    expect(formatApiError(503, body)).toBe(body);
    expect(formatApiError(503, body)).not.toBe(DISCOVERY_LOADING_MESSAGE);
  });

  it("clears stale apply errors when health recovers (no duplicate banners; see also e2e Item 57 in ui.spec.ts)", () => {
    expect(reconcileApplySectionOnConfigHealth("JSON syntax error at line 2 column 3")).toEqual({
      clearPreview: true,
      clearApplyError: true,
      clearExportResult: true,
    });
    expect(reconcileApplySectionOnConfigHealth(null)).toEqual({
      clearPreview: false,
      clearApplyError: true,
      clearExportResult: false,
    });
  });

  it("still retries discovery-in-progress 503 JSON", () => {
    const body = JSON.stringify({ error: "Discovery in progress; retry preview/apply in a few seconds" });
    expect(isRetryableDiscoveryStatus(503, body)).toBe(true);
    expect(formatApiError(503, body)).toBe(DISCOVERY_LOADING_MESSAGE);
  });
});
