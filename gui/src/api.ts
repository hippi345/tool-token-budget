import type { Report, PolicyOptions, ProposalResponse, ExportResponse, ClientConfig, ApplyPreviewResponse, ApplyResponse, ReportResponse, ServerMetadata, ModelCountSummary } from "./types";
import { formatApiError, postJsonWithDiscoveryRetry } from "./httpErrors";
import { subscribeToEventsWithReconnect } from "./sseReconnectSubscribe";
import { markSessionInvalid } from "./sessionInvalid";

function notifyIfUnauthorized(res: Response): void {
  if (res.status === 401) {
    markSessionInvalid();
  }
}

export interface SnapshotEvent {
  type: "initial" | "update";
  snapshot: {
    timestamp: string;
    report: Report;
  };
  serverMetadata?: ServerMetadata;
  diff?: {
    servers: {
      added: string[];
      removed: string[];
      statusChanged: Array<{ name: string; oldStatus: string; newStatus: string }>;
    };
    tools: {
      added: Array<{ server: string; name: string; estTokens: number }>;
      removed: Array<{ server: string; name: string; estTokens: number }>;
      changed: Array<{
        server: string;
        name: string;
        oldEstTokens: number;
        newEstTokens: number;
        delta: number;
      }>;
    };
    tokens: {
      total: number;
      perServer: Record<string, number>;
    };
  };
}

function getToken(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("token") || "";
}

export async function fetchReport(): Promise<ReportResponse> {
  const res = await fetch("/api/report", {
    headers: {
      "X-Auth-Token": getToken(),
    },
  });
  if (!res.ok) {
    notifyIfUnauthorized(res);
    throw new Error(`Failed to fetch report: ${res.status}`);
  }
  return res.json();
}

export interface AnalyzeHistoryEntry {
  at: string;
  totalTokens: number;
  byClient: Record<string, number>;
  byModel: Record<string, number>;
}

export async function fetchAnalyzeHistory(): Promise<{
  entries: AnalyzeHistoryEntry[];
  sparklines: {
    totals: string;
    byClient: Record<string, string>;
    byModel: Record<string, string>;
  };
  corrupt?: boolean;
  budget?: {
    total?: number;
    clients?: Record<string, number>;
  };
}> {
  const res = await fetch("/api/analyze-history", {
    headers: {
      "X-Auth-Token": getToken(),
    },
  });
  if (!res.ok) {
    notifyIfUnauthorized(res);
    throw new Error(`Failed to fetch analyze history: ${res.status}`);
  }
  return res.json();
}

export async function fetchHealth(): Promise<{
  status: string;
  timestamp: string;
  watchIntervalSec: number;
  countMode?: "offline" | "api" | "auto";
  configLoadError?: string | null;
  defaultClientId?: string | null;
  optionalApis?: { anthropic?: boolean; gemini?: boolean };
}> {
  const res = await fetch("/api/health", {
    headers: {
      "X-Auth-Token": getToken(),
    },
  });
  if (!res.ok) {
    notifyIfUnauthorized(res);
    throw new Error(`Failed to fetch health: ${res.status}`);
  }
  return res.json();
}

export async function fetchClients(): Promise<ClientConfig[]> {
  const res = await fetch("/api/clients", {
    headers: {
      "X-Auth-Token": getToken(),
    },
  });
  if (!res.ok) {
    notifyIfUnauthorized(res);
    throw new Error(`Failed to fetch clients: ${res.status}`);
  }
  const data = await res.json();
  return data.clients;
}

export async function postProposal(policy: PolicyOptions, clientId?: string): Promise<ProposalResponse> {
  const res = await fetch("/api/proposal", {
    method: "POST",
    headers: {
      "X-Auth-Token": getToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ policy, clientId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatApiError(res.status, text || `Failed to generate proposal: ${res.status}`));
  }
  return res.json();
}

export async function postExport(policy: PolicyOptions, clientId: string): Promise<ExportResponse> {
  const res = await fetch("/api/export", {
    method: "POST",
    headers: {
      "X-Auth-Token": getToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ policy, clientId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatApiError(res.status, text || `Failed to export: ${res.status}`));
  }
  return res.json();
}

export async function postWatchInterval(intervalSec: number): Promise<{ success: boolean; intervalSec: number }> {
  const res = await fetch("/api/watch-interval", {
    method: "POST",
    headers: {
      "X-Auth-Token": getToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ intervalSec }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatApiError(res.status, text || `Failed to update watch interval: ${res.status}`));
  }
  return res.json();
}

export async function postApplyPreview(policy: PolicyOptions, clientId: string): Promise<ApplyPreviewResponse> {
  const res = await postJsonWithDiscoveryRetry("/api/apply/preview", {
    method: "POST",
    headers: {
      "X-Auth-Token": getToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ policy, clientId }),
  });
  return res.json();
}

export async function postApply(
  policy: PolicyOptions, 
  clientId: string, 
  previewHash: string,
  previewToken: string,
  confirmation: string
): Promise<ApplyResponse> {
  const res = await fetch("/api/apply", {
    method: "POST",
    headers: {
      "X-Auth-Token": getToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ policy, clientId, previewHash, previewToken, confirmation }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatApiError(res.status, text || `Apply failed: ${res.status}`));
  }
  return res.json();
}

export async function fetchModelPresets(): Promise<
  Array<{ id: string; family: string; framing: string; offlineSource: string; experimental?: boolean }>
> {
  const res = await fetch("/api/model-presets", {
    headers: { "X-Auth-Token": getToken() },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch model presets: ${res.status}`);
  }
  const data = await res.json();
  return data.models;
}

export class ModelCountsHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Model counts failed: ${status}`);
    this.name = "ModelCountsHttpError";
    this.status = status;
    this.body = body;
  }
}

export async function postModelCounts(body: {
  modelIds: string[];
  primaryModelId?: string;
  countMode?: "offline" | "api" | "auto";
}): Promise<{
  tokenCountsByModel: Record<string, ModelCountSummary>;
  tools: Array<{ server: string; name: string; countsByModel: Record<string, number> }>;
}> {
  const res = await fetch("/api/model-counts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": getToken(),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    notifyIfUnauthorized(res);
    throw new ModelCountsHttpError(res.status, text);
  }
  try {
    return JSON.parse(text) as {
      tokenCountsByModel: Record<string, ModelCountSummary>;
      tools: Array<{ server: string; name: string; countsByModel: Record<string, number> }>;
    };
  } catch {
    throw new Error("Model counts response was not valid JSON");
  }
}

export function subscribeToEvents(
  onEvent: (event: SnapshotEvent) => void,
  handlers?: {
    onReconnecting?: (attempt: number) => void;
    onReconnected?: () => void;
    onSessionInvalid?: () => void;
  }
): () => void {
  const token = getToken();
  const url = `/api/events`;
  return subscribeToEventsWithReconnect(url, token, {
    onEvent,
    onReconnecting: handlers?.onReconnecting,
    onReconnected: handlers?.onReconnected,
    onSessionInvalid: () => handlers?.onSessionInvalid?.(),
  });
}
