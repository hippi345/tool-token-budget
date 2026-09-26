import type { CountMode } from "./meter/apiTokenCount.js";
import type { ClientFramingProfile } from "./meter/framing.js";

export interface AnalyzeOptions {
  /** Primary model id (default openai:o200k legacy column). */
  primaryModelId?: string;
  /** Additional model ids for multi-column / report.json maps. */
  modelIds?: string[];
  countMode?: CountMode;
  framingOverride?: ClientFramingProfile;
  cacheTokenizers?: string;
  apiCountMax?: number;
  verbose?: boolean;
}

export const DEFAULT_ANALYZE_OPTIONS: AnalyzeOptions = {
  countMode: "offline",
  apiCountMax: 20,
};
