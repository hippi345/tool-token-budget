/**
 * Normalize and apply defaults to a PolicyOptions object.
 * Shared between CLI and API to ensure consistent behavior.
 */

import type { PolicyOptions } from "../types.js";

/**
 * Default policy values (same as CLI defaults).
 * keepPerServer: 2 (keep top 2 tools per server by token cost)
 * keepHot: undefined (no global limit)
 * disableServersOver: undefined (never remove servers by default)
 */
export const DEFAULT_POLICY: PolicyOptions = {
  keepPerServer: 2,
  keepHot: undefined,
  disableServersOver: undefined,
};

/**
 * Normalize a partial policy by filling in defaults.
 * Never changes the input object.
 */
export function normalizePolicy(policy?: Partial<PolicyOptions>): PolicyOptions {
  return {
    keepPerServer: policy?.keepPerServer ?? DEFAULT_POLICY.keepPerServer,
    keepHot: policy?.keepHot ?? DEFAULT_POLICY.keepHot,
    disableServersOver: policy?.disableServersOver ?? DEFAULT_POLICY.disableServersOver,
  };
}
