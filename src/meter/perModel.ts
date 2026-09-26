import type { Tool } from "../types.js";
import type { AnalyzeOptions } from "../analyzeOptions.js";
import {
  DEFAULT_PRIMARY_MODEL_ID,
  framingForCliOverride,
  resolveModelProfile,
  type CountSource,
  type ModelTokenProfile,
} from "./modelCatalog.js";
import {
  buildCursorCatalogPayload,
  buildFramedText,
  buildGeminiFunctionDeclaration,
  buildGeminiToolsRequestPayload,
  type ClientFramingProfile,
} from "./framing.js";
import { ApiCallBudget } from "./apiCallBudget.js";
import { countTiktoken } from "./tiktokenLazy.js";
import { hashSchema } from "./schemaHash.js";
import { getHfTokenCounter } from "./hfTokenize.js";
import {
  countAnthropicToolsApi,
  countGeminiToolsApi,
  readApiCountEnv,
  type CountMode,
} from "./apiTokenCount.js";
import { meterTool } from "./score.js";
import {
  attributeCursorCatalogTokens,
  catalogContextKey,
} from "./catalogAttribution.js";
import { logMeterVerbose } from "./meterVerbose.js";

export interface ModelCountSummary {
  total: number;
  perTool: Record<string, number>;
  framingOverhead?: number;
  source: CountSource;
  framing: string;
  family: string;
  encoding?: string;
}

export interface PerModelCountState {
  tokenCountsByModel: Record<string, ModelCountSummary>;
  primaryModelId: string;
}

interface MemoEntry {
  tokens: number;
  source: CountSource;
}

const countMemo = new Map<string, MemoEntry>();

function tokenizerSlot(
  profile: ModelTokenProfile,
  hfCounter: ((text: string) => number) | null
): string {
  if (hfCounter && profile.hfTokenizerId) {
    return `hf:${profile.hfTokenizerId}`;
  }
  if (profile.encoding) {
    return `tiktoken:${profile.encoding}`;
  }
  return "tiktoken:o200k_base";
}

function memoKey(
  modelId: string,
  framing: ClientFramingProfile,
  tool: Tool,
  catalogCtx: string,
  slot: string
): string {
  return `${modelId}:${framing}:${slot}:${catalogCtx}:${tool.server}::${tool.name}:${hashSchema(tool.inputSchema)}`;
}

export function resetCountMemo(): void {
  countMemo.clear();
}

function countTextWithSource(
  text: string,
  profile: ModelTokenProfile,
  hfCounter: ((text: string) => number) | null
): { tokens: number; source: CountSource } {
  if (hfCounter && profile.hfTokenizerId) {
    return { tokens: hfCounter(text), source: "exact-offline" };
  }
  if (profile.encoding) {
    return { tokens: countTiktoken(text, profile.encoding), source: profile.offlineSource };
  }
  return { tokens: countTiktoken(text, "o200k_base"), source: "estimate" };
}

function offlineCountTool(
  tool: Tool,
  profile: ModelTokenProfile,
  framing: ClientFramingProfile,
  allTools: Tool[],
  hfCounter: ((text: string) => number) | null
): { tokens: number; source: CountSource } {
  const catalogCtx =
    framing === "cursor-catalog" ? catalogContextKey(allTools) : "-";
  const slot = tokenizerSlot(profile, hfCounter);
  const key = memoKey(profile.id, framing, tool, catalogCtx, slot);
  const cached = countMemo.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const text = buildFramedText(tool, framing, allTools);
  const result = countTextWithSource(text, profile, hfCounter);
  countMemo.set(key, result);
  return result;
}

function shouldUseApi(
  profile: ModelTokenProfile,
  mode: CountMode,
  env: ReturnType<typeof readApiCountEnv>
): boolean {
  if (mode === "offline") return false;
  if (mode === "api") {
    if (profile.family === "anthropic") return Boolean(env.anthropicApiKey);
    if (profile.family === "google") return Boolean(env.geminiApiKey);
    return false;
  }
  if (profile.family === "anthropic") return Boolean(env.anthropicApiKey);
  if (profile.family === "google") return Boolean(env.geminiApiKey);
  return false;
}

function logApiFallbackReason(
  profile: ModelTokenProfile,
  countMode: CountMode,
  env: ReturnType<typeof readApiCountEnv>
): void {
  if (countMode === "offline") return;
  if (profile.family === "anthropic" && !env.anthropicApiKey) {
    logMeterVerbose(
      `${profile.id}: api/auto count unavailable (ANTHROPIC_API_KEY not set); using offline ${profile.offlineSource}`
    );
  } else if (profile.family === "google" && !env.geminiApiKey) {
    logMeterVerbose(
      `${profile.id}: api/auto count unavailable (GEMINI_API_KEY not set); using offline ${profile.offlineSource}`
    );
  }
}

function computeOfflineForModel(
  tools: Tool[],
  modelId: string,
  opts: AnalyzeOptions,
  hfCounter: ((text: string) => number) | null
): ModelCountSummary {
  const profile = resolveModelProfile(modelId);
  const framing = framingForCliOverride(opts.framingOverride, profile);
  const perTool: Record<string, number> = {};
  let total = 0;
  let source: CountSource = profile.offlineSource;

  if (
    profile.id === DEFAULT_PRIMARY_MODEL_ID &&
    framing === "cursor-full" &&
    !opts.framingOverride
  ) {
    for (const tool of tools) {
      const key = `${tool.server}::${tool.name}`;
      const tokens = meterTool(tool).estTokens;
      perTool[key] = tokens;
      total += tokens;
    }
    return {
      total,
      perTool,
      source: "estimate",
      framing,
      family: profile.family,
      encoding: profile.encoding,
    };
  }

  if (framing === "cursor-catalog" && tools.length > 0) {
    const countFn = (text: string) =>
      countTextWithSource(text, profile, hfCounter).tokens;
    const attributed = attributeCursorCatalogTokens(tools, countFn);
    source = countTextWithSource(
      buildCursorCatalogPayload(tools),
      profile,
      hfCounter
    ).source;
    return {
      total: attributed.total,
      perTool: attributed.perTool,
      framingOverhead: attributed.framingOverhead,
      source,
      framing,
      family: profile.family,
      encoding: profile.encoding,
    };
  }

  if (framing === "gemini-functions" && tools.length > 0) {
    const requestText = buildGeminiToolsRequestPayload(tools);
    const requestCounted = countTextWithSource(requestText, profile, hfCounter);
    source = requestCounted.source;
    const requestTokens = requestCounted.tokens;
    const weights = tools.map((t) =>
      JSON.stringify(buildGeminiFunctionDeclaration(t)).length
    );
    const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
    tools.forEach((tool, i) => {
      const key = `${tool.server}::${tool.name}`;
      perTool[key] = Math.round((requestTokens * weights[i]) / weightSum);
    });
    total = requestTokens;
    return {
      total,
      perTool,
      source,
      framing,
      family: profile.family,
      encoding: profile.encoding,
    };
  }

  for (const tool of tools) {
    const { tokens, source: toolSource } = offlineCountTool(
      tool,
      profile,
      framing,
      tools,
      hfCounter
    );
    const key = `${tool.server}::${tool.name}`;
    perTool[key] = tokens;
    total += tokens;
    if (toolSource === "estimate") {
      source = "estimate";
    } else if (toolSource === "exact-offline" && source !== "estimate") {
      source = toolSource;
    }
  }

  return {
    total,
    perTool,
    source,
    framing,
    family: profile.family,
    encoding: profile.encoding,
  };
}

function resolveModelIdList(opts: AnalyzeOptions): string[] | undefined {
  const primaryModelId = opts.primaryModelId ?? DEFAULT_PRIMARY_MODEL_ID;
  if (opts.modelIds && opts.modelIds.length > 0) {
    return [...new Set(opts.modelIds)];
  }
  if (primaryModelId !== DEFAULT_PRIMARY_MODEL_ID) {
    return [primaryModelId];
  }
  if (
    opts.framingOverride ||
    opts.countMode === "api" ||
    opts.countMode === "auto"
  ) {
    return [primaryModelId];
  }
  return undefined;
}

export function computePerModelCountsOffline(
  tools: Tool[],
  opts: AnalyzeOptions = {}
): PerModelCountState | undefined {
  const ids = resolveModelIdList(opts);
  if (!ids || ids.length === 0) {
    return undefined;
  }
  const primaryModelId = opts.primaryModelId ?? DEFAULT_PRIMARY_MODEL_ID;

  const tokenCountsByModel: Record<string, ModelCountSummary> = {};
  for (const modelId of ids) {
    tokenCountsByModel[modelId] = computeOfflineForModel(tools, modelId, opts, null);
  }

  return { tokenCountsByModel, primaryModelId };
}

export async function computePerModelCounts(
  tools: Tool[],
  opts: AnalyzeOptions = {}
): Promise<PerModelCountState | undefined> {
  const ids = resolveModelIdList(opts);
  if (!ids || ids.length === 0) {
    return undefined;
  }
  const primaryModelId = opts.primaryModelId ?? DEFAULT_PRIMARY_MODEL_ID;
  const uniqueIds = ids;
  const countMode = opts.countMode ?? "offline";
  const env = readApiCountEnv();
  const apiBudget = new ApiCallBudget(opts.apiCountMax ?? 20);

  const tokenCountsByModel: Record<string, ModelCountSummary> = {};

  for (const modelId of uniqueIds) {
    const profile = resolveModelProfile(modelId);
    const framing = framingForCliOverride(opts.framingOverride, profile);

    let source: CountSource = profile.offlineSource;
    const perTool: Record<string, number> = {};
    let total = 0;

    const useApi = shouldUseApi(profile, countMode, env);
    if (!useApi) {
      logApiFallbackReason(profile, countMode, env);
    }

    if (useApi && profile.family === "anthropic" && env.anthropicApiKey) {
      try {
        const apiResult = await countAnthropicToolsApi(
          tools,
          env.anthropicApiKey,
          modelId,
          apiBudget
        );
        if (apiResult) {
          Object.assign(perTool, apiResult.perTool);
          total = apiResult.total;
          source = "exact-api";
        }
      } catch {
        logMeterVerbose(
          `${modelId}: Anthropic count_tokens failed; using offline ${profile.offlineSource}`
        );
      }
    } else if (useApi && profile.family === "google" && env.geminiApiKey) {
      try {
        const apiResult = await countGeminiToolsApi(
          tools,
          env.geminiApiKey,
          modelId,
          apiBudget
        );
        if (apiResult) {
          Object.assign(perTool, apiResult.perTool);
          total = apiResult.total;
          source = "exact-api";
        }
      } catch {
        logMeterVerbose(
          `${modelId}: Gemini countTokens failed; using offline ${profile.offlineSource}`
        );
      }
    }

    if (source !== "exact-api") {
      let hfCounter: ((text: string) => number) | null = null;
      if (profile.hfTokenizerId) {
        hfCounter = await getHfTokenCounter(
          profile.hfTokenizerId,
          opts.cacheTokenizers
        );
      }
      tokenCountsByModel[modelId] = computeOfflineForModel(
        tools,
        modelId,
        opts,
        hfCounter
      );
      continue;
    }

    tokenCountsByModel[modelId] = {
      total,
      perTool,
      source,
      framing,
      family: profile.family,
      encoding: profile.encoding,
    };
  }

  return { tokenCountsByModel, primaryModelId };
}

export function attachCountsToMeters(
  tools: Tool[],
  meters: { server: string; name: string; estTokens: number }[],
  summary: PerModelCountState
): void {
  for (const m of meters) {
    const countsByModel: Record<string, number> = {};
    for (const [modelId, modelSummary] of Object.entries(
      summary.tokenCountsByModel
    )) {
      const key = `${m.server}::${m.name}`;
      countsByModel[modelId] = modelSummary.perTool[key] ?? 0;
    }
    (m as { countsByModel?: Record<string, number> }).countsByModel =
      countsByModel;
  }
}
