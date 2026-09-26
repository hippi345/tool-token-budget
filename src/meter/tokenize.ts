import { getEncoding } from "js-tiktoken";
import { TOKENIZER_ID } from "../types.js";

const encoding = getEncoding(TOKENIZER_ID as "o200k_base");

/** Estimate token count for text using the locked o200k_base encoder. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return encoding.encode(text).length;
}

export { TOKENIZER_ID };
