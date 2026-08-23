import { queryOptions } from "@tanstack/react-query";
import { trendSeriesQuery } from "@/features/trends/queries";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { DashboardSummaryExtended, LiveProbes } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

export const DASHBOARD_STALE_TIME_MS = 15_000;

export const SPARKLINE_RANGE_DAYS = 30;

export function dashboardQuery(targetId: string | null) {
  return queryOptions({
    queryKey: qk.dashboard.summary(targetId),
    queryFn: async ({ signal }): Promise<DashboardSummaryExtended> => {
      const summary = await unwrap(
        api.GET("/api/v1/dashboard", {
          params: { query: targetId === null ? {} : { target_id: targetId } },
          signal,
        }),
      );
      return { live_probes: null, ...summary };
    },
    staleTime: DASHBOARD_STALE_TIME_MS,
    meta: INLINE_ERROR_META,
  });
}

function selectLiveProbes(summary: DashboardSummaryExtended): LiveProbes | null {
  return summary.live_probes;
}

export function liveProbesQuery(targetId: string | null) {
  return { ...dashboardQuery(targetId), select: selectLiveProbes };
}

export function mutationSummaryQuery(targetId: string) {
  return queryOptions({
    queryKey: qk.mutation.summary(targetId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/mutation/summary", {
          params: { query: { target_id: targetId } },
          signal,
        }),
      ),
    staleTime: DASHBOARD_STALE_TIME_MS,
    meta: INLINE_ERROR_META,
  });
}

export function passHatKTrendQuery(targetId: string) {
  return {
    ...trendSeriesQuery(targetId, "pass_hat_k", SPARKLINE_RANGE_DAYS, null),
    meta: INLINE_ERROR_META,
  };
}
