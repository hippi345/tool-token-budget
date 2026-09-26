export interface AnalyzeHistoryEntry {
  /** ISO timestamp (same as report.generatedAt when recorded). */
  at: string;
  totalTokens: number;
  /** MCP client config id → total estimate for that analyze run. */
  byClient: Record<string, number>;
  /** Model id → total tokens for that model column. */
  byModel: Record<string, number>;
}

export interface AnalyzeHistoryFile {
  version: 1;
  entries: AnalyzeHistoryEntry[];
}
