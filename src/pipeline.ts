import type { Report, Server, Tool } from "./types.js";
import { TOKENIZER_ID } from "./types.js";
import type { AnalyzeOptions } from "./analyzeOptions.js";
import { attachShares, meterTool, rankTools } from "./meter/score.js";
import { lintTools } from "./lint/run.js";
import { formatTextReport } from "./report/formatText.js";
import {
  computePerModelCounts,
  computePerModelCountsOffline,
} from "./meter/perModel.js";
import { DEFAULT_PRIMARY_MODEL_ID } from "./meter/modelCatalog.js";
import { setMeterVerbose } from "./meter/meterVerbose.js";

export { formatTextReport };

function needsPerModel(opts?: AnalyzeOptions): boolean {
  if (!opts) return false;
  if (opts.modelIds && opts.modelIds.length > 0) return true;
  if (
    opts.primaryModelId &&
    opts.primaryModelId !== DEFAULT_PRIMARY_MODEL_ID
  ) {
    return true;
  }
  if (opts.framingOverride) return true;
  if (opts.countMode && opts.countMode !== "offline") return true;
  return false;
}

function mergePerModel(report: Report, tools: Tool[], opts?: AnalyzeOptions): Report {
  const perModel = computePerModelCountsOffline(tools, opts);
  if (!perModel) return report;

  for (const m of report.tools) {
    const countsByModel: Record<string, number> = {};
    for (const [modelId, summary] of Object.entries(perModel.tokenCountsByModel)) {
      const key = `${m.server}::${m.name}`;
      countsByModel[modelId] = summary.perTool[key] ?? 0;
    }
    m.countsByModel = countsByModel;
  }

  return {
    ...report,
    primaryModelId: perModel.primaryModelId,
    tokenCountsByModel: perModel.tokenCountsByModel,
  };
}

/** Analyze discovered tools: meter → lint → ranked report. */
export function analyzeTools(
  tools: Tool[],
  servers: Server[],
  opts?: AnalyzeOptions
): Report {
  const disabledNames = new Set(
    servers.filter((s) => s.status === "config_disabled").map((s) => s.name)
  );
  const activeTools = tools.filter((t) => !disabledNames.has(t.server));
  const activeServers = servers.filter((s) => s.status !== "config_disabled");

  const meters = attachShares(activeTools.map(meterTool));
  const ranked = rankTools(meters);
  const findings = lintTools(activeTools, ranked);
  const estTokens = ranked.reduce((s, m) => s + m.estTokens, 0);
  let report: Report = {
    generatedAt: new Date().toISOString(),
    tokenizerId: TOKENIZER_ID,
    totals: {
      estTokens,
      toolCount: ranked.length,
      serverCount: activeServers.length,
      findingCount: findings.length,
    },
    tools: ranked,
    servers,
    findings,
  };

  if (needsPerModel(opts)) {
    report = mergePerModel(report, activeTools, opts);
  }

  return report;
}

/** Full analysis including optional API exact counts and HF tokenizer load. */
export async function analyzeToolsAsync(
  tools: Tool[],
  servers: Server[],
  opts?: AnalyzeOptions
): Promise<Report> {
  const disabledNames = new Set(
    servers.filter((s) => s.status === "config_disabled").map((s) => s.name)
  );
  const activeTools = tools.filter((t) => !disabledNames.has(t.server));
  const activeServers = servers.filter((s) => s.status !== "config_disabled");

  const meters = attachShares(activeTools.map(meterTool));
  const ranked = rankTools(meters);
  const findings = lintTools(activeTools, ranked);
  const estTokens = ranked.reduce((s, m) => s + m.estTokens, 0);
  let report: Report = {
    generatedAt: new Date().toISOString(),
    tokenizerId: TOKENIZER_ID,
    totals: {
      estTokens,
      toolCount: ranked.length,
      serverCount: activeServers.length,
      findingCount: findings.length,
    },
    tools: ranked,
    servers,
    findings,
  };

  if (!needsPerModel(opts)) {
    return report;
  }

  setMeterVerbose(Boolean(opts?.verbose));
  const perModel = await computePerModelCounts(activeTools, opts);
  if (!perModel) {
    return mergePerModel(report, activeTools, opts);
  }

  for (const m of report.tools) {
    const countsByModel: Record<string, number> = {};
    for (const [modelId, summary] of Object.entries(perModel.tokenCountsByModel)) {
      const key = `${m.server}::${m.name}`;
      countsByModel[modelId] = summary.perTool[key] ?? 0;
    }
    m.countsByModel = countsByModel;
  }

  return {
    ...report,
    primaryModelId: perModel.primaryModelId,
    tokenCountsByModel: perModel.tokenCountsByModel,
  };
}
