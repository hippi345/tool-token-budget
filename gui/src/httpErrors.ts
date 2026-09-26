export const DISCOVERY_LOADING_MESSAGE =
  "Still loading servers, try again in a moment";

export function isConfigUnreadableBody(bodyText: string): boolean {
  const trimmed = bodyText.trim();
  return /config file cannot be read/i.test(trimmed);
}

/** Turn API error bodies into user-facing text (never raw JSON). */
export function formatApiError(status: number, bodyText: string): string {
  const trimmed = bodyText.trim();
  if (status === 503) {
    if (isConfigUnreadableBody(trimmed)) {
      return trimmed;
    }
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as { error?: string };
        if (parsed.error?.toLowerCase().includes("discovery")) {
          return DISCOVERY_LOADING_MESSAGE;
        }
        if (parsed.error?.toLowerCase().includes("config")) {
          return parsed.error;
        }
      } catch {
        // fall through
      }
    }
    return DISCOVERY_LOADING_MESSAGE;
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: string; message?: string };
      const msg = parsed.error || parsed.message;
      if (msg && typeof msg === "string") {
        return msg;
      }
      return `Request failed (${status})`;
    } catch {
      return `Request failed (${status})`;
    }
  }

  if (trimmed) {
    return trimmed;
  }
  return `Request failed (${status})`;
}

export function isRetryableDiscoveryStatus(status: number, bodyText: string): boolean {
  if (status !== 503) return false;
  if (isConfigUnreadableBody(bodyText)) {
    return false;
  }
  const trimmed = bodyText.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as { error?: string };
    return Boolean(parsed.error?.toLowerCase().includes("discovery"));
  } catch {
    return false;
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when a failed POST may be retried (discovery 503 only; never for apply). */
export function shouldRetryDiscoveryPost(url: string, status: number, bodyText: string): boolean {
  if (url.includes("/api/apply") && !url.includes("/api/apply/preview")) {
    return false;
  }
  return isRetryableDiscoveryStatus(status, bodyText);
}

/** POST with short backoff retries while discovery is still running (503). */
export async function postJsonWithDiscoveryRetry(
  url: string,
  init: RequestInit,
  opts?: { maxAttempts?: number; delaysMs?: number[] }
): Promise<Response> {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const delaysMs = opts?.delaysMs ?? [400, 800, 1200, 1600];
  let lastRes: Response | null = null;
  let lastText = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) {
      return res;
    }
    const text = await res.text();
    lastRes = res;
    lastText = text;
    if (
      !shouldRetryDiscoveryPost(url, res.status, text) ||
      attempt >= maxAttempts - 1
    ) {
      throw new Error(formatApiError(res.status, text));
    }
    await sleep(delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 1600);
  }

  throw new Error(formatApiError(lastRes?.status ?? 503, lastText));
}
