import type { ClientFramingProfile } from "./framing.js";

export type CountSource = "exact-offline" | "exact-api" | "estimate";

export type ModelFamily =
  | "openai"
  | "anthropic"
  | "google"
  | "meta"
  | "qwen"
  | "mistral"
  | "unknown";

export interface ModelTokenProfile {
  id: string;
  family: ModelFamily;
  /** js-tiktoken encoding id when applicable */
  encoding?: "o200k_base" | "cl100k_base";
  framing: ClientFramingProfile;
  /** Default offline source for this model */
  offlineSource: CountSource;
  /** HuggingFace tokenizer repo id when family uses HF */
  hfTokenizerId?: string;
}

export const DEFAULT_PRIMARY_MODEL_ID = "openai:o200k";

export const PRESET_MODELS: ModelTokenProfile[] = [
  {
    id: "openai:o200k",
    family: "openai",
    encoding: "o200k_base",
    framing: "cursor-full",
    offlineSource: "exact-offline",
  },
  {
    id: "gpt-4o",
    family: "openai",
    encoding: "o200k_base",
    framing: "openai-tools",
    offlineSource: "exact-offline",
  },
  {
    id: "claude-sonnet-4-5",
    family: "anthropic",
    encoding: "o200k_base",
    framing: "anthropic-tools",
    offlineSource: "estimate",
  },
  {
    id: "gemini-2.0-flash",
    family: "google",
    encoding: "o200k_base",
    framing: "gemini-functions",
    offlineSource: "estimate",
  },
  {
    id: "cursor-dynamic",
    family: "openai",
    encoding: "o200k_base",
    framing: "cursor-catalog",
    offlineSource: "estimate",
  },
  {
    id: "llama-3.1-8b",
    family: "meta",
    framing: "openai-tools",
    offlineSource: "exact-offline",
    hfTokenizerId: "meta-llama/Llama-3.1-8B",
  },
  {
    id: "qwen2.5-7b",
    family: "qwen",
    framing: "openai-tools",
    offlineSource: "exact-offline",
    hfTokenizerId: "Qwen/Qwen2.5-7B",
  },
  {
    id: "mistral-7b",
    family: "mistral",
    framing: "openai-tools",
    offlineSource: "exact-offline",
    hfTokenizerId: "mistralai/Mistral-7B-v0.1",
  },
  {
    id: "llama-hf-fixture",
    family: "meta",
    framing: "cursor-full",
    offlineSource: "exact-offline",
    hfTokenizerId: "fixture-tiny-bpe",
  },
];

export function isExperimentalModelId(modelId: string): boolean {
  return modelId === "cursor-dynamic";
}

/** Presets exposed in the GUI (test-only models hidden unless env requests them). */
export function listPresetModelsForUi(): ModelTokenProfile[] {
  if (
    process.env.TOOL_TOKEN_BUDGET_EXPOSE_TEST_MODELS === "1" ||
    process.env.NODE_ENV === "test"
  ) {
    return PRESET_MODELS;
  }
  return PRESET_MODELS.filter((m) => m.id !== "llama-hf-fixture");
}

const byId = new Map(PRESET_MODELS.map((m) => [m.id, m]));

export function resolveModelProfile(modelId: string): ModelTokenProfile {
  const known = byId.get(modelId);
  if (known) return known;

  const lower = modelId.toLowerCase();
  if (lower.includes("claude")) {
    return {
      id: modelId,
      family: "anthropic",
      encoding: "o200k_base",
      framing: "anthropic-tools",
      offlineSource: "estimate",
    };
  }
  if (lower.includes("gemini")) {
    return {
      id: modelId,
      family: "google",
      encoding: "o200k_base",
      framing: "gemini-functions",
      offlineSource: "estimate",
    };
  }
  if (lower.includes("llama")) {
    return {
      id: modelId,
      family: "meta",
      framing: "openai-tools",
      offlineSource: "estimate",
      hfTokenizerId: modelId,
    };
  }
  if (lower.includes("qwen")) {
    return {
      id: modelId,
      family: "qwen",
      framing: "openai-tools",
      offlineSource: "estimate",
    };
  }
  if (lower.includes("mistral")) {
    return {
      id: modelId,
      family: "mistral",
      framing: "openai-tools",
      offlineSource: "estimate",
    };
  }
  if (lower.includes("gpt") || lower.startsWith("o1") || lower.startsWith("o3")) {
    return {
      id: modelId,
      family: "openai",
      encoding: "o200k_base",
      framing: "openai-tools",
      offlineSource: "exact-offline",
    };
  }
  return {
    id: modelId,
    family: "unknown",
    encoding: "o200k_base",
    framing: "cursor-full",
    offlineSource: "estimate",
  };
}

export function parseModelList(
  primary?: string,
  extraCsv?: string,
  maxExtra = 8
): string[] {
  const ids: string[] = [];
  const primaryId = primary ?? DEFAULT_PRIMARY_MODEL_ID;
  ids.push(primaryId);
  if (extraCsv) {
    for (const part of extraCsv.split(",")) {
      const trimmed = part.trim();
      if (trimmed && !ids.includes(trimmed)) {
        ids.push(trimmed);
      }
    }
  }
  return ids.slice(0, maxExtra);
}

export function framingForCliOverride(
  override?: string,
  profile?: ModelTokenProfile
): ClientFramingProfile {
  if (override) {
    return override as ClientFramingProfile;
  }
  return profile?.framing ?? "cursor-full";
}
