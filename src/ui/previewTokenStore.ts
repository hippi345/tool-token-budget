import { createHash, randomBytes } from "node:crypto";
import type { PolicyOptions } from "../types.js";
import { normalizePolicy } from "../emit/normalizePolicy.js";

export interface PreviewTokenRecord {
  targetPath: string;
  contentHash: string;
  clientId: string;
  policyHash: string;
  baselineHash: string;
  issuedAt: number;
}

const DEFAULT_PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;
const PREVIEW_TOKEN_CAP = 500;

export function previewTokenTtlMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const primary = Number(env.TOOL_TOKEN_BUDGET_PREVIEW_TOKEN_TTL_MS);
  if (Number.isFinite(primary) && primary > 0) {
    return primary;
  }
  const legacy = Number(env.SCHEMA_BUDGET_PREVIEW_TOKEN_TTL_MS);
  if (Number.isFinite(legacy) && legacy > 0) {
    return legacy;
  }
  return DEFAULT_PREVIEW_TOKEN_TTL_MS;
}

export function policyFingerprint(policy: PolicyOptions): string {
  const normalized = normalizePolicy(policy);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export class PreviewTokenStore {
  private readonly issued = new Map<string, PreviewTokenRecord>();
  private readonly consumed = new Set<string>();

  pruneExpired(now = Date.now()): void {
    for (const [token, rec] of this.issued) {
      if (now - rec.issuedAt > previewTokenTtlMs()) {
        this.issued.delete(token);
      }
    }
  }

  private enforceCap(): void {
    while (this.issued.size >= PREVIEW_TOKEN_CAP) {
      const oldest = [...this.issued.entries()].sort(
        (a, b) => a[1].issuedAt - b[1].issuedAt
      )[0];
      if (!oldest) break;
      this.issued.delete(oldest[0]);
    }
  }

  issue(record: Omit<PreviewTokenRecord, "issuedAt">): string {
    this.pruneExpired();
    this.enforceCap();
    const token = randomBytes(24).toString("hex");
    this.issued.set(token, { ...record, issuedAt: Date.now() });
    return token;
  }

  get(token: string): PreviewTokenRecord | undefined {
    this.pruneExpired();
    const rec = this.issued.get(token);
    if (!rec) return undefined;
    if (Date.now() - rec.issuedAt > previewTokenTtlMs()) {
      this.issued.delete(token);
      return undefined;
    }
    return rec;
  }

  markConsumed(token: string): void {
    this.consumed.add(token);
  }

  isConsumed(token: string): boolean {
    return this.consumed.has(token);
  }
}
