import { PRESET_MODELS } from "./modelCatalog.js";

const PRESET_IDS = new Set(PRESET_MODELS.map((m) => m.id));

const TEST_ONLY_MODEL_IDS = new Set(["llama-hf-fixture"]);

export function exposeTestOnlyModels(): boolean {
  if (process.env.TOOL_TOKEN_BUDGET_EXPOSE_TEST_MODELS === "0") {
    return false;
  }
  return (
    process.env.NODE_ENV === "test" ||
    process.env.TOOL_TOKEN_BUDGET_EXPOSE_TEST_MODELS === "1"
  );
}

/** Models accepted by CLI flags and POST /api/model-counts. */
export function isModelIdAllowedForCliApi(modelId: string): boolean {
  if (!PRESET_IDS.has(modelId)) {
    return false;
  }
  if (TEST_ONLY_MODEL_IDS.has(modelId) && !exposeTestOnlyModels()) {
    return false;
  }
  return true;
}
