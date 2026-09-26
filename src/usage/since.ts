const DAY_MS = 86_400_000;

/** Parse --since values: `30d` (default unit days) or ISO calendar date. */
export function parseSinceOption(raw: string | undefined, now = Date.now()): Date {
  const text = (raw ?? "30d").trim();
  const dayMatch = /^(\d+)\s*d(?:ays?)?$/i.exec(text);
  if (dayMatch) {
    const days = Number(dayMatch[1]);
    if (!Number.isFinite(days) || days < 0) {
      throw new Error(`Invalid --since window: ${raw}`);
    }
    return new Date(now - days * DAY_MS);
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid --since: expected NNd or ISO date, got ${raw}`);
  }
  return new Date(parsed);
}

export function defaultSinceDays(raw: string | undefined): number {
  const text = (raw ?? "30d").trim();
  const dayMatch = /^(\d+)\s*d(?:ays?)?$/i.exec(text);
  if (dayMatch) {
    return Number(dayMatch[1]);
  }
  const since = parseSinceOption(raw);
  return Math.max(1, Math.ceil((Date.now() - since.getTime()) / DAY_MS));
}
