import type { ModelCountSummary } from "./types";

export interface CountModeLabelContext {
  optionalApis?: { anthropic?: boolean; gemini?: boolean };
  primarySummary?: Pick<ModelCountSummary, "source"> | null;
}

function effectiveResultLabel(
  source: ModelCountSummary["source"] | undefined
): "exact" | "estimate" {
  if (source === "exact-api" || source === "exact-offline") {
    return "exact";
  }
  return "estimate";
}

/** User-facing count mode label (configured mode + effective result when they differ). */
export function countModeDisplayLabel(
  countMode: "offline" | "api" | "auto",
  ctx?: CountModeLabelContext
): string {
  const result = effectiveResultLabel(ctx?.primarySummary?.source);
  const apis = ctx?.optionalApis;
  const hasKeys = Boolean(apis?.anthropic || apis?.gemini);

  switch (countMode) {
    case "api":
      if (result === "estimate" && !hasKeys) {
        return "api (no keys, estimate)";
      }
      if (result === "estimate") {
        return "api (estimate)";
      }
      return "api (exact)";
    case "auto":
      if (result === "estimate" && !hasKeys) {
        return "auto (no keys, estimate)";
      }
      if (result === "estimate") {
        return "auto (estimate)";
      }
      return "auto (exact)";
    case "offline":
    default:
      return "estimate";
  }
}
