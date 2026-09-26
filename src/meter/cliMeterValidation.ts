import type { ClientFramingProfile } from "./framing.js";
import type { CountMode } from "./apiTokenCount.js";
import { isModelIdAllowedForCliApi } from "./modelIdAllowlist.js";

export const VALID_COUNT_MODES: CountMode[] = ["offline", "api", "auto"];

export const VALID_FRAMING_PROFILES: ClientFramingProfile[] = [
  "cursor-catalog",
  "cursor-full",
  "anthropic-tools",
  "openai-tools",
  "vscode-flat",
  "gemini-functions",
  "claude-full-inject",
];

export const MAX_EXTRA_CLI_MODELS = 8;

export function isValidCountMode(mode: string): mode is CountMode {
  return (VALID_COUNT_MODES as string[]).includes(mode);
}

export function isValidFramingProfile(framing: string): framing is ClientFramingProfile {
  return (VALID_FRAMING_PROFILES as string[]).includes(framing);
}

export function validateAnalyzeCliMeterFlags(opts: {
  model?: string;
  models?: string;
  countMode?: string;
  framing?: string;
}): { ok: true } | { ok: false; message: string } {
  if (opts.countMode !== undefined && !isValidCountMode(opts.countMode)) {
    return {
      ok: false,
      message: `Invalid --count-mode: ${opts.countMode} (expected offline|api|auto)`,
    };
  }
  if (opts.framing !== undefined && !isValidFramingProfile(opts.framing)) {
    return {
      ok: false,
      message: `Invalid --framing: ${opts.framing}`,
    };
  }
  if (opts.model !== undefined && !isModelIdAllowedForCliApi(opts.model)) {
    return {
      ok: false,
      message: `Unknown --model id: ${opts.model}`,
    };
  }
  if (opts.models) {
    const extras = opts.models
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (extras.length > MAX_EXTRA_CLI_MODELS) {
      return {
        ok: false,
        message: `Too many --models entries (max ${MAX_EXTRA_CLI_MODELS} extra ids)`,
      };
    }
    for (const id of extras) {
      if (!isModelIdAllowedForCliApi(id)) {
        return { ok: false, message: `Unknown --models id: ${id}` };
      }
    }
  }
  return { ok: true };
}

export function validateModelCountsApiPayload(payload: {
  modelIds?: unknown;
  primaryModelId?: unknown;
  countMode?: unknown;
}): { ok: true } | { ok: false; error: string } {
  if (payload.countMode !== undefined) {
    if (typeof payload.countMode !== "string" || !isValidCountMode(payload.countMode)) {
      return { ok: false, error: "countMode must be offline, api, or auto" };
    }
  }
  if (payload.primaryModelId !== undefined) {
    if (
      typeof payload.primaryModelId !== "string" ||
      !payload.primaryModelId.trim() ||
      !isModelIdAllowedForCliApi(payload.primaryModelId)
    ) {
      return { ok: false, error: "unknown or invalid primaryModelId" };
    }
  }
  return { ok: true };
}
