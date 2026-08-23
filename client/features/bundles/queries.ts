import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";

export const LIMITS_STALE_TIME_MS = 60 * 60 * 1000;
export const BUNDLE_PAGE_SIZE = 50;
export const BUNDLE_SORT_KEYS = ["version"] as const;
export const DEFAULT_BUNDLE_SORT = "-version";

export function limitsQuery() {
  return queryOptions({
    queryKey: qk.limits(),
    queryFn: ({ signal }) => unwrap(api.GET("/api/v1/limits", { signal })),
    staleTime: LIMITS_STALE_TIME_MS,
  });
}

export function bundleVersionsOptions(targetId: string, sort: string = DEFAULT_BUNDLE_SORT) {
  return cursorInfiniteOptions({
    queryKey: [...qk.targets.bundles(targetId), "list", sort] as const,
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/targets/{target_id}/bundles", {
          params: {
            path: { target_id: targetId },
            query: {
              cursor: cursor ?? undefined,
              limit: BUNDLE_PAGE_SIZE,
              include_total: true,
              sort,
            },
          },
          signal,
        }),
      ),
  });
}

export function bundleDetailQuery(bundleId: string) {
  return queryOptions({
    queryKey: qk.bundles.detail(bundleId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/bundles/{bundle_id}", {
          params: { path: { bundle_id: bundleId } },
          signal,
        }),
      ),
  });
}

export function bundleDiffQuery(bundleId: string, against: string | null) {
  return queryOptions({
    queryKey: qk.bundles.diff(bundleId, against),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/bundles/{bundle_id}/diff", {
          params: {
            path: { bundle_id: bundleId },
            query: against === null ? {} : { against },
          },
          signal,
        }),
      ),
  });
}

export function bundleFilesQuery(bundleId: string) {
  return queryOptions({
    queryKey: qk.bundles.files(bundleId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/bundles/{bundle_id}/files", {
          params: { path: { bundle_id: bundleId } },
          signal,
        }),
      ),
  });
}

export function bundleFileQuery(bundleId: string, path: string) {
  return queryOptions({
    queryKey: qk.bundles.file(bundleId, path),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/bundles/{bundle_id}/files/{path}", {
          params: { path: { bundle_id: bundleId, path } },
          signal,
        }),
      ),
    staleTime: Infinity,
  });
}
