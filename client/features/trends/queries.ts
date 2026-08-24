import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { TrendMetric } from "@/lib/api/types";

export const TREND_METRICS = [
  "pass_hat_k",
  "open_findings",
  "cost_usd",
  "latency_p50_ms",
  "flaky_rate",
] as const satisfies readonly TrendMetric[];

export const TREND_RANGE_DAYS = [7, 30, 90] as const;

export type TrendRangeDays = (typeof TREND_RANGE_DAYS)[number];

export const DEFAULT_TREND_RANGE_DAYS: TrendRangeDays = 30;

export const MIN_TREND_POINTS = 2;

export const TREND_STALE_TIME_MS = 30_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function trendSeriesQuery(
  targetId: string,
  metric: TrendMetric,
  rangeDays: TrendRangeDays,
  planId: string | null,
) {
  return queryOptions({
    queryKey: qk.trends.series(targetId, metric, `${rangeDays}d`, planId),
    queryFn: ({ signal }) => {
      const to = new Date();
      const from = new Date(to.getTime() - rangeDays * MS_PER_DAY);
      return unwrap(
        api.GET("/api/v1/trends", {
          params: {
            query: {
              target_id: targetId,
              metric,
              from: from.toISOString(),
              to: to.toISOString(),
              ...(planId === null ? {} : { plan_id: planId }),
            },
          },
          signal,
        }),
      );
    },
    staleTime: TREND_STALE_TIME_MS,
  });
}
