import type { AnalyzeOptions } from "./analyzeOptions.js";
import type { CountMode } from "./meter/apiTokenCount.js";
import type { ClientFramingProfile } from "./meter/framing.js";
import {
  validateAnalyzeCliMeterFlags,
  isValidCountMode,
} from "./meter/cliMeterValidation.js";

export function buildAnalyzeOptionsFromCli(opts: {
  model?: string;
  models?: string;
  countMode?: string;
  framing?: string;
  cacheTokenizers?: string;
  apiCountMax?: string;
  verbose?: boolean;
}): AnalyzeOptions | undefined {
  const validated = validateAnalyzeCliMeterFlags(opts);
  if (!validated.ok) {
    throw new Error(validated.message);
  }
  const modelIds: string[] = [];
  if (opts.model) {
    modelIds.push(opts.model);
  }
  if (opts.models) {
    for (const part of opts.models.split(",")) {
      const trimmed = part.trim();
      if (trimmed && !modelIds.includes(trimmed)) {
        modelIds.push(trimmed);
      }
    }
  }

  const countMode = (opts.countMode ?? "offline") as CountMode;
  if (!isValidCountMode(countMode)) {
    throw new Error(`Invalid --count-mode: ${opts.countMode}`);
  }
  const hasModels = modelIds.length > 0;
  const hasFraming = Boolean(opts.framing);
  const hasApiMode = countMode === "api" || countMode === "auto";

  if (!hasModels && !hasFraming && !hasApiMode) {
    return undefined;
  }

  return {
    primaryModelId: opts.model,
    modelIds: hasModels ? modelIds : undefined,
    countMode,
    framingOverride: opts.framing as ClientFramingProfile | undefined,
    cacheTokenizers: opts.cacheTokenizers,
    apiCountMax: opts.apiCountMax ? Number(opts.apiCountMax) : 20,
    verbose: opts.verbose,
  };
}
