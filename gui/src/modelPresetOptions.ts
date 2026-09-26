import { isValidPrimaryModelId } from "./primaryModel";
import {
  DEFAULT_PRIMARY_MODEL_ID,
  type ModelPresetOption,
} from "./modelConstants";

export { DEFAULT_PRIMARY_MODEL_ID, type ModelPresetOption };

/** Always include legacy default and the user's current primary in picker options. */
export function buildModelSelectOptions(
  presets: ModelPresetOption[],
  primaryModelId: string,
  extraModelId?: string
): ModelPresetOption[] {
  const byId = new Map<string, ModelPresetOption>();

  const ensure = (id: string, experimental?: boolean) => {
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { id, experimental });
      return;
    }
    if (experimental && !existing.experimental) {
      byId.set(id, { ...existing, experimental });
    }
  };

  ensure(DEFAULT_PRIMARY_MODEL_ID);
  if (presets.length === 0 || isValidPrimaryModelId(primaryModelId, presets)) {
    ensure(primaryModelId);
  }
  const extra = extraModelId?.trim();
  if (
    extra &&
    extra !== primaryModelId &&
    (presets.length === 0 || isValidPrimaryModelId(extra, presets))
  ) {
    ensure(extra);
  }
  for (const p of presets) {
    ensure(p.id, p.experimental);
  }

  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}
