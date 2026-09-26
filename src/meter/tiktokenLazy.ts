import { getEncoding, type Tiktoken } from "js-tiktoken";

const encoders = new Map<string, Tiktoken>();

export function getTiktokenEncoding(id: "o200k_base" | "cl100k_base"): Tiktoken {
  const cached = encoders.get(id);
  if (cached) return cached;
  const enc = getEncoding(id);
  encoders.set(id, enc);
  return enc;
}

export function countTiktoken(text: string, encodingId: "o200k_base" | "cl100k_base"): number {
  if (!text) return 0;
  return getTiktokenEncoding(encodingId).encode(text).length;
}
