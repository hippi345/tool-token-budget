export const SESSION_RESTART_MESSAGE =
  "Server restarted with a new session. Reopen the URL printed in the terminal.";

let sessionInvalid = false;
const listeners = new Set<() => void>();

export function markSessionInvalid(): void {
  if (sessionInvalid) {
    return;
  }
  sessionInvalid = true;
  for (const listener of listeners) {
    listener();
  }
}

export function isSessionInvalid(): boolean {
  return sessionInvalid;
}

export function onSessionInvalid(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** @internal tests only */
export function resetSessionInvalidForTests(): void {
  sessionInvalid = false;
}
