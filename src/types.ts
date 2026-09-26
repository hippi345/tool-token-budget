export type ServerStatus =
  | "ok"
  | "timed_out"
  | "spawn_failed"
  | "handshake_failed"
  | "tools_list_failed"
  | "skipped_remote"
  | "config_disabled";

export interface Server {
  name: string;
  transportSummary?: string;
  status: ServerStatus;
  error?: string;
}

export interface Tool {
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
}

export interface TokenBreakdown {
  name: number;
  description: number;
  schema: number;
}

export interface ToolMeter {
  server: string;
  name: string;
  estTokens: number;
  breakdown: TokenBreakdown;
  shareOfServer: number;
  shareOfAll: number;
  /** Per-model token counts when multi-model analysis is enabled. */
  countsByModel?: Record<string, number>;
}

export type LintSeverity = "info" | "warn" | "error";

export interface LintFinding {
  ruleId: string;
  severity: LintSeverity;
  server: string;
  tool: string;
  message: string;
  suggestion?: string;
}

export interface ReportTotals {
  estTokens: number;
  toolCount: number;
  serverCount: number;
  findingCount: number;
}

export interface SavingsSummary {
  currentEstTokens: number;
  proposedEstTokens: number;
  savedEstTokens: number;
  savedPct: number;
  deferredToolsCount?: number;
  removedServersCount?: number;
  removedServers?: string[];
  /** Extra savings from deferring never-used tools (usage-aware emit). */
  usageDeferSavingsEstTokens?: number;
}

export interface ToolUsageRow {
  server: string;
  tool: string;
  callCount: number;
  used: boolean;
  estTokens: number;
}

export interface UsageClientStatus {
  id: string;
  status: "ok" | "missing" | "unreadable";
  message?: string;
  scannedPaths?: string[];
}

export interface UsageSummary {
  sinceIso: string;
  windowDays: number;
  clients: UsageClientStatus[];
  tools: ToolUsageRow[];
  usageDeferSavingsEstTokens: number;
  noLogsPlainMessage?: string;
}

export type CountSource = "exact-offline" | "exact-api" | "estimate";

export interface ModelCountSummary {
  total: number;
  perTool: Record<string, number>;
  /** Unattributed cursor-catalog tokens (marginals sum + overhead === total). */
  framingOverhead?: number;
  source: CountSource;
  framing: string;
  family?: string;
  encoding?: string;
}

export interface ReportBudgetStatusCheck {
  kind: "total" | "client" | "model";
  id?: string;
  limit: number;
  actual: number;
  exceeded: boolean;
  nearLimit: boolean;
}

export interface ReportBudgetStatus {
  checks: ReportBudgetStatusCheck[];
  anyExceeded: boolean;
  anyNearLimit: boolean;
}

export interface Report {
  generatedAt: string;
  tokenizerId: string;
  /** Primary model id when --model is used (tokenizerId remains legacy alias). */
  primaryModelId?: string;
  tokenCountsByModel?: Record<string, ModelCountSummary>;
  totals: ReportTotals;
  tools: ToolMeter[];
  servers: Server[];
  findings: LintFinding[];
  savings?: SavingsSummary;
  /** SHA-256 of source mcp.json at emit time (CLI apply consistency check). */
  sourceConfigHash?: string;
  /** Local client log usage (read-only; no log contents). */
  usage?: UsageSummary;
  /** User-config token budgets (--json only when checks run). */
  budgetStatus?: ReportBudgetStatus;
}

export type EmitProfile =
  | "claude"
  | "cursor"
  | "generic"
  | "vscode"
  | "windsurf"
  | "gemini-settings"
  | "antigravity"
  | "codex";

export interface PolicyOptions {
  keepHot?: number;
  keepPerServer?: number;
  disableServersOver?: number;
}

export const TOKENIZER_ID = "o200k_base";
