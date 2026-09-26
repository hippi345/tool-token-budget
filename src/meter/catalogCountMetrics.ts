/** Instrumentation for cursor-catalog tokenization call counts (tests only). */
let catalogTokenizerCalls = 0;

export function resetCatalogTokenizerCallCount(): void {
  catalogTokenizerCalls = 0;
}

export function incrementCatalogTokenizerCallCount(): void {
  catalogTokenizerCalls += 1;
}

export function getCatalogTokenizerCallCount(): number {
  return catalogTokenizerCalls;
}
