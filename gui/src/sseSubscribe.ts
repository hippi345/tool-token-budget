import type { SnapshotEvent } from "./api";
import { appendSseResponseText, createSseParseState } from "./sseEventStream";

export class SseUnauthorizedError extends Error {
  constructor() {
    super("SSE unauthorized");
    this.name = "SseUnauthorizedError";
  }
}

export function subscribeToEventsViaXhr(
  url: string,
  token: string,
  onEvent: (event: SnapshotEvent) => void,
  onError: (err: Error) => void,
  xhrFactory: () => XMLHttpRequest = () => new XMLHttpRequest()
): () => void {
  const xhr = xhrFactory();
  xhr.open("GET", url);
  xhr.setRequestHeader("X-Auth-Token", token);
  xhr.setRequestHeader("Accept", "text/event-stream");

  const state = createSseParseState();
  let authFailureHandled = false;

  const maybeHandleAuthFailure = () => {
    if (authFailureHandled) {
      return true;
    }
    if (xhr.status === 401) {
      authFailureHandled = true;
      xhr.abort();
      onError(new SseUnauthorizedError());
      return true;
    }
    return false;
  };

  xhr.onreadystatechange = () => {
    if (xhr.readyState >= XMLHttpRequest.HEADERS_RECEIVED) {
      maybeHandleAuthFailure();
    }
  };

  xhr.onprogress = () => {
    if (maybeHandleAuthFailure()) {
      return;
    }
    for (const evt of appendSseResponseText(state, xhr.responseText)) {
      onEvent(evt);
    }
  };

  xhr.onerror = () => {
    if (authFailureHandled) {
      return;
    }
    onError(new Error("SSE connection error"));
  };

  xhr.send();

  return () => {
    xhr.abort();
  };
}
