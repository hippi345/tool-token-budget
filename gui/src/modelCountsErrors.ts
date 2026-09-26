import { ModelCountsHttpError } from "./api";
import { SESSION_RESTART_MESSAGE, isSessionInvalid } from "./sessionInvalid";

/** 400 from /api/model-counts when primary or model id is not in the catalog. */
export function isUnknownPrimaryModelCountsError(
  status: number,
  body: string
): boolean {
  if (status !== 400) return false;
  return /unknown model id|unknown or invalid primaryModelId/i.test(body);
}

export function modelCountsLoadErrorMessage(err: unknown): string {
  if (isSessionInvalid()) {
    return SESSION_RESTART_MESSAGE;
  }
  if (err instanceof ModelCountsHttpError) {
    if (err.status === 401) {
      return SESSION_RESTART_MESSAGE;
    }
    const detail = err.body.trim() || `HTTP ${err.status}`;
    return `Couldn't load model counts: ${detail}`;
  }
  if (err instanceof Error && err.message) {
    return `Couldn't load model counts: ${err.message}`;
  }
  return "Couldn't load model counts: unknown error";
}
