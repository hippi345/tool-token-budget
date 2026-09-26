import type { Tool } from "../types.js";
import { buildAnthropicToolPayload } from "./framing.js";
import type { ApiCallBudget } from "./apiCallBudget.js";

export type CountMode = "offline" | "api" | "auto";

export interface ApiCountEnv {
  anthropicApiKey?: string;
  geminiApiKey?: string;
}

export function readApiCountEnv(): ApiCountEnv {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
  };
}

export function apiConfiguredFlags(): { anthropic: boolean; gemini: boolean } {
  const env = readApiCountEnv();
  return {
    anthropic: Boolean(env.anthropicApiKey),
    gemini: Boolean(env.geminiApiKey),
  };
}

export type FetchFn = typeof fetch;

export interface ApiCountResult {
  total: number;
  perTool: Record<string, number>;
  source: "exact-api";
}

let fetchImpl: FetchFn = globalThis.fetch.bind(globalThis);

export function setApiFetchImpl(fn: FetchFn): void {
  fetchImpl = fn;
}

export function resetApiFetchImpl(): void {
  fetchImpl = globalThis.fetch.bind(globalThis);
}

/** Anthropic: one count_tokens HTTP call for all tools (all servers). */
export async function countAnthropicToolsApi(
  tools: Tool[],
  apiKey: string,
  modelId: string,
  budget?: ApiCallBudget
): Promise<ApiCountResult | null> {
  if (budget && !budget.tryConsume()) {
    return null;
  }

  const anthropicTools = tools.map((t) => JSON.parse(buildAnthropicToolPayload(t)));
  const res = await fetchImpl("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelId,
      tools: anthropicTools,
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic count_tokens failed: ${res.status}`);
  }
  const body = (await res.json()) as { input_tokens?: number };
  const total = body.input_tokens ?? 0;
  const perTool: Record<string, number> = {};
  const weights = tools.map((t) => buildAnthropicToolPayload(t).length);
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
  tools.forEach((t, i) => {
    const key = `${t.server}::${t.name}`;
    perTool[key] = Math.round((total * weights[i]) / weightSum);
  });

  return { total, perTool, source: "exact-api" };
}

/** Gemini countTokens for function declarations (Developer API). */
export async function countGeminiToolsApi(
  tools: Tool[],
  apiKey: string,
  modelId: string,
  budget?: ApiCallBudget
): Promise<ApiCountResult | null> {
  if (budget && !budget.tryConsume()) {
    return null;
  }

  const functionDeclarations = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.inputSchema ?? {},
  }));

  const res = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:countTokens`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "tools" }] }],
        tools: [{ functionDeclarations }],
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Gemini countTokens failed: ${res.status}`);
  }
  const body = (await res.json()) as { totalTokens?: number };
  const total = body.totalTokens ?? 0;
  const perTool: Record<string, number> = {};
  const weights = tools.map((t) => JSON.stringify(t.inputSchema ?? {}).length + t.name.length);
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
  tools.forEach((t, i) => {
    const key = `${t.server}::${t.name}`;
    perTool[key] = Math.round((total * weights[i]) / weightSum);
  });
  return { total, perTool, source: "exact-api" };
}
