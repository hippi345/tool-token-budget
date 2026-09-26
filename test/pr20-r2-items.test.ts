import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import { isPathContainedIn } from "../src/utils/pathContainment.js";
import {
  parseVSCodeSettingsJsonc,
  settingsJsonHasLegacyMcpServersFromText,
} from "../src/discover/clientConfigs.js";
import {
  appendSseResponseText,
  createSseParseState,
} from "../gui/src/sseEventStream.ts";
import { subscribeToEventsViaXhr } from "../gui/src/sseSubscribe.ts";
import {
  shouldShowExportError,
} from "../gui/src/configHealthUi.ts";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REBRAND_ALLOWLIST = [
  "tool-token-budget-export",
  "tool-token-budget-proposed",
  "tool-token-budget-theme",
  "tool-token-budget/",
  "tool-token-budget.lock",
  "schema-budget-export",
  "schema-budget-proposed",
  "schema-budget.keep",
  "tool-token-budget.keep",
  "schema-budget-theme",
  "schema-budget`",
  'schema-budget"',
  "schema-budget:",
  "schema-budget ",
  "schema-budget/",
  "schema-budget.lock",
  "tool-token-budget-demo",
  "schema-budget-design",
  "schema-budget.sarif",
  "schema-budget analyze",
  "schema-budget emit",
  "schema-budget apply",
  "schema-budget ui",
  "bin alias",
  "backward-compatible alias",
  'name: "schema-budget"',
];

function isAllowedUserFacingLine(line: string): boolean {
  if (!/\bschema-budget\b|\bSchema Budget\b/i.test(line)) {
    return true;
  }
  return REBRAND_ALLOWLIST.some((frag) => line.includes(frag));
}

function walkTextFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir)) {
    const full = path.join(dir, ent);
    if (statSync(full).isDirectory()) {
      if (ent === "superpowers") continue;
      out.push(...walkTextFiles(full, base));
    } else if (/\.(md|txt|tape|sh)$/.test(ent) && !ent.endsWith(".gif")) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

function sseBlock(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("PR #20 round-2", () => {
  it("pr20-r2-item01 POSIX and win32 injected path modules are platform-proof", () => {
    const posix = path.posix;
    const parent = "/tmp/ParentDir";
    const child = "/tmp/parentdir/nested/file.txt";
    expect(
      isPathContainedIn(child, parent, { caseInsensitive: true, pathModule: posix })
    ).toBe(true);
    expect(
      isPathContainedIn(child, parent, { caseInsensitive: false, pathModule: posix })
    ).toBe(false);

    const win32 = path.win32;
    const winParent = "C:\\ParentDir";
    const winChild = "C:\\parentdir\\nested\\file.txt";
    expect(
      isPathContainedIn(winChild, winParent, { caseInsensitive: true, pathModule: win32 })
    ).toBe(true);
    expect(
      isPathContainedIn("C:\\OtherDir\\file.txt", winParent, {
        caseInsensitive: false,
        pathModule: win32,
      })
    ).toBe(false);
  });

  it("pr20-r2-item02 SSE delivers each event once (chunked/trim) and never opens token-less EventSource", () => {
    const state = createSseParseState();
    let responseText = "";
    const received: number[] = [];

    const push = (chunk: string) => {
      responseText += chunk;
      for (const evt of appendSseResponseText(state, responseText)) {
        received.push((evt as { id: number }).id);
      }
    };

    push(sseBlock({ id: 1, type: "initial" }).slice(0, 12));
    push(sseBlock({ id: 1, type: "initial" }).slice(12));
    push(sseBlock({ id: 2, type: "update" }));
    push(sseBlock({ id: 3, type: "update" }));

    expect(received).toEqual([1, 2, 3]);

    const state2 = createSseParseState();
    let rt = sseBlock({ id: 4 }).slice(0, 14);
    expect(appendSseResponseText(state2, rt)).toHaveLength(0);
    rt = sseBlock({ id: 4 });
    const finished = appendSseResponseText(state2, rt);
    expect(finished).toHaveLength(1);
    expect((finished[0] as { id: number }).id).toBe(4);
    rt += sseBlock({ id: 5 });
    const more = appendSseResponseText(state2, rt);
    expect(more).toHaveLength(1);
    expect((more[0] as { id: number }).id).toBe(5);

    let eventSourceCount = 0;
    const Original = globalThis.EventSource;
    class MockEventSource {
      constructor() {
        eventSourceCount++;
      }
      close() {}
    }
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;

    class MockXHR {
      responseText = "";
      onprogress: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      send() {
        this.responseText = sseBlock({ type: "initial", snapshot: { timestamp: "t", report: {} } });
        this.onprogress?.();
      }
      abort() {}
    }

    const seen: string[] = [];
    subscribeToEventsViaXhr(
      "/api/events",
      "tok",
      (e) => seen.push(e.type),
      () => {},
      () => new MockXHR() as unknown as XMLHttpRequest
    );

    expect(eventSourceCount).toBe(0);
    expect(seen).toEqual(["initial"]);
    globalThis.EventSource = Original;
  });

  it("pr20-r2-item03 hides export error banner when configLoadError is set", () => {
    expect(shouldShowExportError("Cannot export", "JSON syntax error")).toBe(false);
    expect(shouldShowExportError("Cannot export", null)).toBe(true);
    expect(shouldShowExportError(null, null)).toBe(false);
  });

  it("pr20-r2-item04 JSONC settings parse handles BOM, trailing commas, and strings", () => {
    const bom = "\uFEFF{\n  \"mcp\": { \"servers\": { \"a\": {} }, },\n}\n";
    expect(settingsJsonHasLegacyMcpServersFromText(bom)).toBe(true);

    const trailing = `{
      "note": "comma, inside string",
      "mcp": { "servers": { "srv": {} }, },
    }`;
    expect(settingsJsonHasLegacyMcpServersFromText(trailing)).toBe(true);
    const parsed = parseVSCodeSettingsJsonc(trailing) as { note: string };
    expect(parsed.note).toBe("comma, inside string");

    const commented = `{
      // line comment
      "mcp": { "servers": { "x": {} } }
    }`;
    expect(settingsJsonHasLegacyMcpServersFromText(commented)).toBe(true);
  });

  it("pr20-r2-item05 docs and demos text have no stale Schema Budget outside allowlist", () => {
    const roots = [
      path.join(repoRoot, "docs"),
      path.join(repoRoot, "demos"),
    ];
    const files = roots.flatMap((r) => walkTextFiles(r, repoRoot));
    for (const rel of files) {
      const text = readFileSync(path.join(repoRoot, rel), "utf8");
      for (let i = 0; i < text.split("\n").length; i++) {
        const line = text.split("\n")[i] ?? "";
        expect(isAllowedUserFacingLine(line), `${rel}:${i + 1} ${line.trim()}`).toBe(true);
      }
    }
    expect(readFileSync(path.join(repoRoot, "docs", "client-config-paths.md"), "utf8")).toContain(
      "Tool Token Budget"
    );
  });

  it("pr20-r2-item06 globalSetup records os.userInfo().homedir not faked HOME", async () => {
    const mod = await import("./setup/globalSetup.ts");
    const prev = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      REAL_HOME: process.env.REAL_HOME,
      __TEST_REAL_HOME: process.env.__TEST_REAL_HOME,
    };
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "pr20-r2-fake-home-"));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    delete process.env.__TEST_REAL_HOME;
    delete process.env.REAL_HOME;

    mod.default();
    const recorded = process.env.__TEST_REAL_HOME;
    expect(recorded).toBeTruthy();
    expect(recorded).toBe(os.userInfo().homedir);
    expect(path.normalize(recorded!)).not.toBe(path.normalize(fakeHome));

    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    process.env.REAL_HOME = prev.REAL_HOME;
    process.env.__TEST_REAL_HOME = prev.__TEST_REAL_HOME;
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("pr20-r2-item07 demo tape hides setup with Hide/Show before visible demo", async () => {
    const tape = await readFile(path.join(repoRoot, "demos", "tape.tape"), "utf8");
    const hideIdx = tape.indexOf("Hide");
    const showIdx = tape.indexOf("Show");
    const demoIdx = tape.indexOf('Type "# Tool Token Budget Demo"');
    expect(hideIdx).toBeGreaterThan(-1);
    expect(showIdx).toBeGreaterThan(hideIdx);
    expect(demoIdx).toBeGreaterThan(showIdx);
    const visible = tape.slice(showIdx);
    expect(visible).not.toMatch(/Type "cd demos"/);
    expect(visible).not.toMatch(/alias tool-token-budget/);

    const renderGif = await readFile(path.join(repoRoot, "demos", "render-gif.sh"), "utf8");
    const deleteOnOptimizedGif =
      /gifsicle[^\n]*--delete/.test(renderGif) && !/--unoptimize/.test(renderGif);
    expect(deleteOnOptimizedGif).toBe(false);

    const gif = path.join(repoRoot, "demos", "tool-token-budget-demo.gif");
    const st = statSync(gif);
    expect(st.size).toBeGreaterThan(10_000);
  });
});
