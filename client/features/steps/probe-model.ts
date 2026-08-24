import type { InvariantPack, ProbeAnswerType, ProbeResult, ProbeStatus } from "@/lib/api/types";

export const PROBE_STATUSES = [
  "decided",
  "uncertain",
  "error",
] as const satisfies readonly ProbeStatus[];

export const PROBE_STATUS_LABELS: Record<ProbeStatus, string> = {
  decided: "Decided",
  uncertain: "Uncertain",
  error: "Error",
};

export const PROBE_STATUS_MEANINGS: Record<ProbeStatus, string> = {
  decided: "Laya answered and the confidence reached the threshold.",
  uncertain: "Laya was not sure enough, so the step escalates to the judge.",
  error: "The call failed and gave no answer. An error is never a pass.",
};

export const PACK_LABELS: Record<InvariantPack, string> = {
  generic: "Generic pack",
  llm_app: "LLM app pack",
  target: "Target pack",
};

export const ANSWER_TYPE_LABELS: Record<ProbeAnswerType, string> = {
  yes_no: "Yes or no",
  choice: "One choice of several",
};

const PACK_ORDER: readonly InvariantPack[] = ["generic", "llm_app", "target"];

export interface ClampedUnit {
  reported: number;
  value: number;
  clamped: boolean;
}

export function clampUnit(reported: number): ClampedUnit {
  if (!Number.isFinite(reported)) {
    return { reported, value: 0, clamped: true };
  }
  const value = Math.min(1, Math.max(0, reported));
  return { reported, value, clamped: value !== reported };
}

export function formatUnit(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

export function isBelowThreshold(result: Pick<ProbeResult, "confidence" | "threshold">): boolean {
  return clampUnit(result.confidence).value < clampUnit(result.threshold).value;
}

export interface ProbeSummary {
  total: number;
  decided: number;
  uncertain: number;
  errored: number;
  belowThreshold: number;
  unresolved: number;
  latencyMs: number;
}

export function summarizeProbes(probes: readonly ProbeResult[]): ProbeSummary {
  const decided = probes.filter((probe) => probe.status === "decided");
  const uncertain = probes.filter((probe) => probe.status === "uncertain").length;
  const errored = probes.filter((probe) => probe.status === "error").length;
  const belowThreshold = decided.filter((probe) => isBelowThreshold(probe)).length;
  return {
    total: probes.length,
    decided: decided.length,
    uncertain,
    errored,
    belowThreshold,
    unresolved: uncertain + errored + belowThreshold,
    latencyMs: probes.reduce((sum, probe) => sum + Math.max(0, probe.latency_ms), 0),
  };
}

export function describeProbeSummary(summary: ProbeSummary): string {
  const parts = [`${summary.total} ${summary.total === 1 ? "probe" : "probes"}`];
  if (summary.decided > 0) {
    parts.push(`${summary.decided} decided`);
  }
  if (summary.uncertain > 0) {
    parts.push(`${summary.uncertain} uncertain`);
  }
  if (summary.errored > 0) {
    parts.push(`${summary.errored} errored`);
  }
  if (summary.belowThreshold > 0) {
    parts.push(`${summary.belowThreshold} below the threshold`);
  }
  return parts.join(", ");
}

export interface ProbePackGroup {
  pack: InvariantPack;
  results: ProbeResult[];
}

export function groupProbesByPack(probes: readonly ProbeResult[]): ProbePackGroup[] {
  return PACK_ORDER.flatMap((pack) => {
    const results = probes.filter((probe) => probe.pack === pack);
    return results.length === 0 ? [] : [{ pack, results }];
  });
}
