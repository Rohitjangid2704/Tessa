import type { TrendMetric } from "@/lib/api/types";
import { formatUsd } from "@/lib/format-usd";
import { formatMilliseconds } from "@/features/runs/format";
import { formatCount, formatPercent } from "@/features/runs/results-format";

export interface TrendMetricInfo {
  label: string;
  description: string;
  color: string;
  fractional: boolean;
  format: (value: number) => string;
}

export const TREND_METRIC_INFO = {
  pass_hat_k: {
    label: "pass^k",
    description: "Share of finished scenarios where every attempt passed",
    color: "var(--chart-1)",
    fractional: true,
    format: formatPercent,
  },
  open_findings: {
    label: "Open findings",
    description: "Findings still open after each run",
    color: "var(--chart-5)",
    fractional: false,
    format: formatCount,
  },
  cost_usd: {
    label: "Cost",
    description: "Total spend of each run",
    color: "var(--chart-3)",
    fractional: false,
    format: formatUsd,
  },
  latency_p50_ms: {
    label: "Median step latency",
    description: "p50 latency of the steps of each run",
    color: "var(--chart-2)",
    fractional: false,
    format: formatMilliseconds,
  },
  flaky_rate: {
    label: "Flaky rate",
    description: "Share of finished scenarios that were flaky",
    color: "var(--chart-4)",
    fractional: true,
    format: formatPercent,
  },
} as const satisfies Record<TrendMetric, TrendMetricInfo>;

export const TREND_RANGE_LABELS = {
  7: "7 days",
  30: "30 days",
  90: "90 days",
} as const satisfies Record<7 | 30 | 90, string>;
