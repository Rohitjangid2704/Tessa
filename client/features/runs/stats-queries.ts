import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { InvariantPack, VerdictStatus } from "@/lib/api/types";

export const RUN_STATS_REFRESH_MS = 5000;
export const INVARIANT_RESULTS_PAGE_SIZE = 50;

export interface InvariantResultFilters {
  status?: VerdictStatus[];
  invariant_id?: string[];
  pack?: InvariantPack[];
}

export function runStatsQuery(runId: string, live: boolean) {
  return queryOptions({
    queryKey: qk.runs.stats(runId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/runs/{run_id}/stats", {
          params: { path: { run_id: runId } },
          signal,
        }),
      ),
    staleTime: RUN_STATS_REFRESH_MS,
    refetchInterval: live ? RUN_STATS_REFRESH_MS : false,
    refetchIntervalInBackground: false,
  });
}

export function runInvariantsQuery(
  runId: string,
  filters: InvariantResultFilters = {},
  pageSize = INVARIANT_RESULTS_PAGE_SIZE,
) {
  return cursorInfiniteOptions({
    queryKey: qk.runs.invariants(runId, { ...filters, limit: pageSize }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/runs/{run_id}/invariants", {
          params: {
            path: { run_id: runId },
            query: { ...filters, cursor, limit: pageSize, include_total: true },
          },
          signal,
        }),
      ),
  });
}
