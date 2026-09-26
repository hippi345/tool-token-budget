export type ServerStatus =
  | "ok"
  | "timed_out"
  | "spawn_failed"
  | "handshake_failed"
  | "tools_list_failed"
  | "skipped_remote";

export interface Server {
  name: string;
  transportSummary?: string;
  status: ServerStatus;
  error?: string;
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
  countsByModel?: Record<string, number>;
}

export type CountSource = "exact-offline" | "exact-api" | "estimate";

export interface ModelCountSummary {
  total: number;
  perTool: Record<string, number>;
  framingOverhead?: number;
  source: CountSource;
  framing: string;
  family?: string;
  encoding?: string;
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
}

export interface Report {
  generatedAt: string;
  tokenizerId: string;
  primaryModelId?: string;
  tokenCountsByModel?: Record<string, ModelCountSummary>;
  totals: ReportTotals;
  tools: ToolMeter[];
  servers: Server[];
  findings: LintFinding[];
  savings?: SavingsSummary;
}

export interface ServerMetadata {
  reportSource: 'tools-json' | 'config';
  configLoadError?: string | null;
}

export interface ReportResponse {
  report: Report;
  serverMetadata: ServerMetadata;
}

export interface PolicyOptions {
  keepHot?: number;
  keepPerServer?: number;
  disableServersOver?: number;
}

export interface ClientConfig {
  id: string;
  name: string;
  profile: string | null;
  viewOnly: boolean;
}

export interface ProposalResponse {
  savings: SavingsSummary;
  keepProposal: {
    version: number;
    note: string;
    keepHot: string[];
    defer: string[];
    byServer: Record<string, { keepHot: string[]; defer: string[] }>;
  };
  deferHints: unknown;
  proposedConfig: unknown;
  removedServers: string[];
  hasZeroKeptWarning: boolean;
}

export interface ExportResponse {
  success: boolean;
  written: string[];
  exportDir: string;
}

export interface ApplyPreviewResponse {
  diff: string;
  currentHash: string;
  previewToken: string;
  originalConfig: unknown;
  proposedConfig: unknown;
}

export interface ApplyResponse {
  success: boolean;
  noOp?: boolean;
  backupPath?: string;
  message?: string;
}
