/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { renameWithRetry, isTransientRenameError } from "../src/utils/renameWithRetry.js";
import {
  readConfigUtf8WithRetry,
  isTransientConfigReadError,
} from "../src/config/readConfigWithRetry.js";
import { buildModelSelectOptions } from "../gui/src/modelPresetOptions.js";
import { countModeDisplayLabel } from "../gui/src/countModeDisplay.js";
import { formatTextReport } from "../src/report/formatText.js";
import { attributeCursorCatalogTokens } from "../src/meter/catalogAttribution.js";
import { analyzeToolsAsync } from "../src/pipeline.js";
import { loadToolsJson } from "../src/discover/fromToolsJson.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "../src/types.js";
import { subscribeToEventsWithReconnect } from "../gui/src/sseReconnectSubscribe.js";
import * as sseSubscribe from "../gui/src/sseSubscribe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bloatedPath = path.join(__dirname, "../fixtures/tools-bloated.json");

describe("Stage 1 review round 6", () => {
  it("stage1-r6-item1a: renameWithRetry retries transient EPERM", async () => {
    expect(isTransientRenameError({ code: "EPERM" })).toBe(true);
    let calls = 0;
    await renameWithRetry("/tmp/a.tmp", "/tmp/a", {
      maxAttempts: 5,
      baseDelayMs: 1,
      renameFn: async () => {
        calls++;
        if (calls < 3) {
          const err = new Error("locked") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
      },
    });
    expect(calls).toBe(3);
  });

  it("stage1-r6-item1b: readConfigUtf8WithRetry retries EPERM then succeeds", async () => {
    expect(isTransientConfigReadError({ code: "EBUSY" })).toBe(true);
    let attempts = 0;
    const content = await readConfigUtf8WithRetry("/fake/mcp.json", {
      maxAttempts: 4,
      baseDelayMs: 1,
      readFileFn: async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error("busy") as NodeJS.ErrnoException;
          err.code = "EBUSY";
          throw err;
        }
        return '{"mcpServers":{}}';
      },
    });
    expect(content).toContain("mcpServers");
    expect(attempts).toBe(3);
  });

  it("stage1-r6-item2: compare model kept in options when presets fail", () => {
    const opts = buildModelSelectOptions([], "openai:o200k", "gpt-4o");
    const ids = opts.map((o) => o.id);
    expect(ids).toContain("gpt-4o");
  });

  it("stage1-r6-item4: dashboard tables use scroll wrapper not display block shrink", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(path.join(__dirname, "../gui/src/App.css"), "utf8");
    expect(css).toContain(".table-scroll-wrap");
    expect(css).not.toMatch(/\.dashboard table\s*\{[^}]*display:\s*block/);
  });

  it("stage1-r6-item3: count mode label shows configured api with estimate when no keys", () => {
    expect(
      countModeDisplayLabel("api", {
        optionalApis: { anthropic: false, gemini: false },
        primarySummary: { source: "estimate" },
      })
    ).toBe("api (no keys, estimate)");
    expect(
      countModeDisplayLabel("api", {
        optionalApis: { anthropic: true },
        primarySummary: { source: "exact-api" },
      })
    ).toBe("api (exact)");
  });

  it("stage1-r6-item5a: per-tool text includes framing overhead under cursor-dynamic", async () => {
    const { servers, tools } = await loadToolsJson(bloatedPath);
    const report = await analyzeToolsAsync(tools, servers, {
      modelIds: ["cursor-dynamic"],
      countMode: "offline",
    });
    const detailed = formatTextReport(report, { perModelDetail: true });
    const plain = formatTextReport(report);
    expect(detailed).toMatch(/framing overhead: \d+/);
    expect(plain).not.toMatch(/framing overhead:/);
    const summary = report.tokenCountsByModel?.["cursor-dynamic"];
    const marginalSum = Object.values(summary!.perTool).reduce((a, b) => a + b, 0);
    expect(marginalSum + (summary!.framingOverhead ?? 0)).toBe(summary!.total);
  });

  it("stage1-r6-item1c: Windows uses poll-only config refresh (no fs.watch handle)", async () => {
    const { readFileSync } = await import("node:fs");
    const cliSrc = readFileSync(path.join(__dirname, "../src/cli.ts"), "utf8");
    expect(cliSrc).toMatch(/process\.platform !== "win32"/);
    expect(cliSrc).toMatch(/persistent:\s*false/);
  });

  it("stage1-r6-item5b: catalog attribution normalizes when marginals exceed total", () => {
    const tools: Tool[] = [
      {
        server: "s",
        name: "a",
        description: "d",
        inputSchema: { type: "object" },
        estTokens: 1,
        breakdown: { name: 0, description: 0, schema: 1 },
      },
      {
        server: "s",
        name: "b",
        description: "d",
        inputSchema: { type: "object" },
        estTokens: 1,
        breakdown: { name: 0, description: 0, schema: 1 },
      },
    ];
    let call = 0;
    const result = attributeCursorCatalogTokens(tools, () => {
      call++;
      if (call === 1) return 10;
      return 3;
    });
    expect(result.total).toBe(10);
    const sum = Object.values(result.perTool).reduce((a, b) => a + b, 0);
    expect(sum + result.framingOverhead).toBe(result.total);
    expect(result.framingOverhead).toBe(0);
  });

  it("stage1-r6-item6: SSE reconnect schedules retry after transport error", async () => {
    const instances: Array<{ abort: () => void }> = [];
    vi.spyOn(sseSubscribe, "subscribeToEventsViaXhr").mockImplementation(
      (_url, _token, _onEvent, onError) => {
        const handle = { abort: () => {} };
        instances.push(handle);
        queueMicrotask(() => onError(new Error("SSE connection error")));
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
    dispose();
    vi.restoreAllMocks();
  });
});
