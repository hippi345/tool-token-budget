import { isModelIdAllowedForCliApi } from "./modelIdAllowlist.js";

export const MAX_MODEL_IDS_PER_REQUEST = 16;

export function isAllowedModelId(modelId: string): boolean {
  return isModelIdAllowedForCliApi(modelId);
}

export function validateModelIdsPayload(
  modelIds: unknown
): { ok: true; modelIds: string[] } | { ok: false; error: string } {
  if (!Array.isArray(modelIds)) {
    return { ok: false, error: "modelIds must be an array of strings" };
  }
  if (modelIds.length === 0) {
    return { ok: false, error: "modelIds must not be empty" };
  }
  if (modelIds.length > MAX_MODEL_IDS_PER_REQUEST) {
    return {
      ok: false,
      error: `modelIds exceeds maximum of ${MAX_MODEL_IDS_PER_REQUEST}`,
    };
  }
  for (const id of modelIds) {
    if (typeof id !== "string" || !id.trim()) {
      return { ok: false, error: "each modelId must be a non-empty string" };
    }
    if (!isAllowedModelId(id)) {
      return { ok: false, error: `unknown model id: ${id}` };
    }
  }
  return { ok: true, modelIds };
}
