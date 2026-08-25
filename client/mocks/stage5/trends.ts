import { stableUnit } from "../stage2/ids";
import type { RunEntry } from "../stage2/store";
import type { RunScenario, RunStats, TrendMetric, TrendPoint, TrendSeries } from "@/lib/api/types";
import { buildRunStats } from "./stats";

export const TREND_METRICS = [
  "pass_hat_k",
  "open_findings",
  "cost_usd",
  "latency_p50_ms",
  "flaky_rate",
] as const satisfies readonly TrendMetric[];

export const DEFAULT_TREND_RANGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const NIGHTLY_OFFSET_MS = 2 * 60 * 60 * 1000;

export interface TrendRun {
  entry: RunEntry;
  rows: readonly RunScenario[];
  openFindings: number;
}

export interface TrendRequest {
  metric: TrendMetric;
  fromMs: number;
  toMs: number;
  planId: string | null;
  runs: readonly TrendRun[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function metricValueOf(metric: TrendMetric, stats: RunStats): number | null {
  switch (metric) {
    case "pass_hat_k":
      return stats.pass_hat_k;
    case "open_findings":
      return stats.open_findings;
    case "cost_usd":
      return stats.cost_usd.total;
    case "latency_p50_ms":
      return stats.latency_ms.p50;
    case "flaky_rate":
      return stats.flaky_rate;
  }
}

export function syntheticValue(metric: TrendMetric, planKey: string, dayIndex: number): number {
  const noise = stableUnit("trend", metric, planKey, dayIndex);
  switch (metric) {
    case "pass_hat_k": {
      const raw = 0.72 + 0.16 * Math.sin(dayIndex / 6) + (noise - 0.5) * 0.08;
      return Number(clamp(raw, 0.4, 0.98).toFixed(4));
    }
    case "open_findings":
      return Math.round(14 + 6 * Math.sin(dayIndex / 9 + 1) + noise * 5);
    case "cost_usd":
      return Number((1.2 + 0.4 * Math.sin(dayIndex / 7 + 2) + noise * 0.2).toFixed(4));
    case "latency_p50_ms":
      return Math.round(820 + 140 * Math.sin(dayIndex / 5) + noise * 60);
    case "flaky_rate": {
      const raw = 0.06 + 0.03 * Math.sin(dayIndex / 8 + 3) + noise * 0.02;
      return Number(clamp(raw, 0, 1).toFixed(4));
    }
  }
}

function timestampOf(run: RunEntry["run"]): string {
  return run.finished_at ?? run.created_at;
}

export function buildTrendSeries(request: TrendRequest): TrendSeries {
  const real: TrendPoint[] = request.runs.flatMap((candidate) => {
    const ts = timestampOf(candidate.entry.run);
    const ms = Date.parse(ts);
    if (ms < request.fromMs || ms > request.toMs) {
      return [];
    }
    const value = metricValueOf(
      request.metric,
      buildRunStats(candidate.entry, candidate.rows, candidate.openFindings),
    );
    return value === null ? [] : [{ ts, value, run_id: candidate.entry.run.id }];
  });
  const realDays = new Set(real.map((point) => Math.floor(Date.parse(point.ts) / DAY_MS)));
  const planKey = request.planId ?? "all";
  const synthetic: TrendPoint[] = [];
  for (
    let day = Math.floor(request.fromMs / DAY_MS);
    day <= Math.floor(request.toMs / DAY_MS);
    day += 1
  ) {
    const ms = day * DAY_MS + NIGHTLY_OFFSET_MS;
    if (ms >= request.fromMs && ms <= request.toMs && !realDays.has(day)) {
      synthetic.push({
        ts: new Date(ms).toISOString(),
        value: syntheticValue(request.metric, planKey, day),
        run_id: null,
      });
    }
  }
  const points = [...synthetic, ...real].sort((left, right) => left.ts.localeCompare(right.ts));
  return { metric: request.metric, points };
}
