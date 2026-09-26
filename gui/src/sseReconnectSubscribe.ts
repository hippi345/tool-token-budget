import type { SnapshotEvent } from "./api";
import { subscribeToEventsViaXhr, SseUnauthorizedError } from "./sseSubscribe";
import { markSessionInvalid } from "./sessionInvalid";

export interface SseReconnectOptions {
  onEvent: (event: SnapshotEvent) => void;
  onReconnecting?: (attempt: number) => void;
  onReconnected?: () => void;
  onSessionInvalid?: () => void;
  maxBackoffMs?: number;
}

export function subscribeToEventsWithReconnect(
  url: string,
  token: string,
  options: SseReconnectOptions
): () => void {
  const { onEvent, onReconnecting, onReconnected, onSessionInvalid, maxBackoffMs = 8000 } =
    options;
  let disposed = false;
  let attempt = 0;
  let unsubscribe: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (disposed) return;
    attempt += 1;
    onReconnecting?.(attempt);
    const delay = Math.min(250 * 2 ** (attempt - 1), maxBackoffMs);
    clearRetry();
    retryTimer = setTimeout(() => {
      connect();
    }, delay);
  };

  const connect = () => {
    if (disposed) return;
    unsubscribe?.();
    let opened = false;
    unsubscribe = subscribeToEventsViaXhr(
      url,
      token,
      (evt) => {
        if (!opened) {
          opened = true;
          if (attempt > 0) {
            onReconnected?.();
          }
          attempt = 0;
        }
        onEvent(evt);
      },
      (err) => {
        if (disposed) return;
        if (err instanceof SseUnauthorizedError) {
          disposed = true;
          clearRetry();
          unsubscribe?.();
          markSessionInvalid();
          onSessionInvalid?.();
          return;
        }
        scheduleReconnect();
      }
    );
  };

  connect();

  return () => {
    disposed = true;
    clearRetry();
    unsubscribe?.();
    unsubscribe = null;
  };
}
