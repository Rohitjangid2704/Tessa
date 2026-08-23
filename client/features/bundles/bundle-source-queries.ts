import { queryOptions, type InfiniteData } from "@tanstack/react-query";
import { runsListQuery } from "@/features/runs/queries";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { BundleSource, RunStatus, RunSummaryPage } from "@/lib/api/types";

export const IMPORT_RUN_POLL_INTERVAL_MS = 2000;

const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "planning",
  "seeding",
  "running",
  "canceling",
];

type ImportRunData = InfiniteData<RunSummaryPage, string | null>;

export function isNoBundleSource(error: unknown): boolean {
  return isApiError(error) && error.status === 404 && error.code === "not_found";
}

export function bundleSourceQuery(targetId: string) {
  return queryOptions({
    queryKey: qk.bundleSource(targetId),
    queryFn: async ({ signal }): Promise<BundleSource | null> => {
      try {
        return await unwrap(
          api.GET("/api/v1/targets/{target_id}/bundle-source", {
            params: { path: { target_id: targetId } },
            signal,
          }),
        );
      } catch (error) {
        if (isNoBundleSource(error)) {
          return null;
        }
        throw error;
      }
    },
    meta: INLINE_ERROR_META,
  });
}

export function isActiveImportStatus(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

export function latestImportRunQuery(targetId: string) {
  return runsListQuery({ target_id: targetId, kind: ["import"] }, 1);
}

export function importRunRefetchInterval(query: {
  state: { data: ImportRunData | undefined };
}): number | false {
  const latest = query.state.data?.pages[0]?.items[0];
  return latest !== undefined && isActiveImportStatus(latest.status)
    ? IMPORT_RUN_POLL_INTERVAL_MS
    : false;
}
