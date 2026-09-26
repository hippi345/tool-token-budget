/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Report } from "../src/types.js";
import { subscribeToEventsWithReconnect } from "../gui/src/sseReconnectSubscribe.js";
import * as sseSubscribe from "../gui/src/sseSubscribe.js";
import { SseUnauthorizedError } from "../gui/src/sseSubscribe.js";
import { SESSION_RESTART_MESSAGE } from "../gui/src/sessionInvalid.js";
import { modelCountsLoadErrorMessage } from "../gui/src/modelCountsErrors.js";
import { ModelCountsHttpError } from "../gui/src/api.js";
import { waitFor } from "@testing-library/react";

const mockReport: Report = {
  generatedAt: new Date().toISOString(),
  tokenizerId: "o200k_base",
  totals: { estTokens: 100, toolCount: 1, serverCount: 1, findingCount: 0 },
  tools: [
    {
      server: "test",
      name: "tool1",
      estTokens: 100,
      breakdown: { name: 10, description: 30, schema: 60 },
      shareOfServer: 1.0,
      shareOfAll: 1.0,
    },
  ],
  servers: [{ name: "test", status: "ok", transportSummary: "stdio:node" }],
  findings: [],
};

describe("Stage 1 review round 7 (GUI)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stage1-r7-item1c: brief network drop without restart recovers and banner clears", async () => {
    let failOnce = true;
    vi.spyOn(sseSubscribe, "subscribeToEventsViaXhr").mockImplementation(
      (_url, _token, onEvent, onError) => {
        if (failOnce) {
          failOnce = false;
          queueMicrotask(() => onError(new Error("SSE connection error")));
          return () => {};
        }
        queueMicrotask(() =>
          onEvent({
            type: "initial",
            snapshot: { timestamp: new Date().toISOString(), report: mockReport as never },
          })
        );
        return () => {};
      }
    );

    const reconnecting = vi.fn();
    const reconnected = vi.fn();
    const dispose = subscribeToEventsWithReconnect("/api/events", "tok", {
      onEvent: () => {},
      onReconnecting: reconnecting,
      onReconnected: reconnected,
    });

    await waitFor(() => expect(reconnecting).toHaveBeenCalled(), { timeout: 2000 });
    await waitFor(() => expect(reconnected).toHaveBeenCalled(), { timeout: 5000 });
    dispose();
  });

  it("stage1-r7-item1d: 401 during reconnect shows session message and stops retrying", async () => {
    let connectCount = 0;
    vi.spyOn(sseSubscribe, "subscribeToEventsViaXhr").mockImplementation(
      (_url, _token, _onEvent, onError) => {
        connectCount++;
        queueMicrotask(() => onError(new SseUnauthorizedError()));
        return () => {};
      }
    );

    const reconnecting = vi.fn();
    const sessionInvalid = vi.fn();
    const dispose = subscribeToEventsWithReconnect("/api/events", "stale-tok", {
      onEvent: () => {},
      onReconnecting: reconnecting,
      onSessionInvalid: sessionInvalid,
    });

    await waitFor(() => expect(sessionInvalid).toHaveBeenCalled(), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 400));
    expect(connectCount).toBe(1);
    expect(reconnecting).not.toHaveBeenCalled();
    dispose();

    expect(modelCountsLoadErrorMessage(new ModelCountsHttpError(401, '{"error":"Unauthorized"}'))).toBe(
      SESSION_RESTART_MESSAGE
    );
  });
});
