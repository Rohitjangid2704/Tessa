import { queryOptions } from "@tanstack/react-query";
import { bundleFileQuery } from "@/features/bundles/queries";
import { runQuery } from "@/features/runs/run-detail-queries";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { polling } from "@/lib/api/polling";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";

export const SEEDS_PAGE_SIZE = 50;
export const SEEDS_SORT = "-version";

export function seedsListQuery(targetId: string) {
  return cursorInfiniteOptions({
    queryKey: qk.seeds.list(targetId),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/targets/{target_id}/seeds", {
          params: {
            path: { target_id: targetId },
            query: { cursor, limit: SEEDS_PAGE_SIZE, include_total: true, sort: SEEDS_SORT },
          },
          signal,
        }),
      ),
  });
}

export function seedQuery(seedId: string) {
  return queryOptions({
    queryKey: qk.seeds.detail(seedId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/seeds/{seed_id}", {
          params: { path: { seed_id: seedId } },
          signal,
        }),
      ),
  });
}

export function resetScriptQuery(bundleId: string, path: string) {
  return bundleFileQuery(bundleId, path);
}

export function seedRunQuery(runId: string) {
  return { ...runQuery(runId), ...polling.run };
}
