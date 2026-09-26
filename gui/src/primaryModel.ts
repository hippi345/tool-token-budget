import {
  DEFAULT_PRIMARY_MODEL_ID,
  type ModelPresetOption,
} from "./modelConstants";

/** True when id is the legacy default or listed in loaded presets. */
export function isValidPrimaryModelId(
  id: string,
  presets: ModelPresetOption[]
): boolean {
  if (id === DEFAULT_PRIMARY_MODEL_ID) return true;
  return presets.some((p) => p.id === id);
}

/** Pick a stored primary or fall back to the legacy default when presets are known. */
export function resolvePrimaryModelId(
  saved: string | null | undefined,
  presets: ModelPresetOption[]
): string {
  const trimmed = saved?.trim();
  const candidate = trimmed || DEFAULT_PRIMARY_MODEL_ID;
  if (isValidPrimaryModelId(candidate, presets)) {
    return candidate;
  }
  return DEFAULT_PRIMARY_MODEL_ID;
}

export function persistPrimaryModelId(id: string): void {
  localStorage.setItem("ttb-primary-model", id);
}
