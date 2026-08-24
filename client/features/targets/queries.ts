import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { AppKind, TargetTier } from "./types";

export const TARGETS_PAGE_SIZE = 25;
export const TARGET_OPTIONS_LIMIT = 200;
export const APP_KINDS_STALE_TIME_MS = 60 * 60 * 1000;

export interface TargetListFilters {
  q?: string;
  app_kind?: AppKind[];
  tier?: TargetTier[];
  include_archived?: boolean;
  sort?: string;
}

export function targetsListQuery(filters: TargetListFilters = {}, pageSize = TARGETS_PAGE_SIZE) {
  return cursorInfiniteOptions({
    queryKey: qk.targets.list({ ...filters, limit: pageSize }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/targets", {
          params: { query: { ...filters, cursor, limit: pageSize, include_total: true } },
          signal,
        }),
      ),
  });
}

export function targetOptionsQuery() {
  return queryOptions({
    queryKey: qk.targets.options(),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/targets", {
          params: { query: { limit: TARGET_OPTIONS_LIMIT, sort: "name" } },
          signal,
        }),
      ),
    select: (page) => page.items,
  });
}

export function targetQuery(targetId: string) {
  return queryOptions({
    queryKey: qk.targets.detail(targetId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/targets/{target_id}", {
          params: { path: { target_id: targetId } },
          signal,
        }),
      ),
  });
}

export function useTarget(targetId: string) {
  return useQuery(targetQuery(targetId));
}

export function appKindsQuery() {
  return queryOptions({
    queryKey: qk.appKinds(),
    queryFn: ({ signal }) => unwrap(api.GET("/api/v1/app-kinds", { signal })),
    staleTime: APP_KINDS_STALE_TIME_MS,
  });
}

export function isTargetNotFound(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 422);
}

export function latestBundleQuery(targetId: string) {
  return queryOptions({
    queryKey: [...qk.targets.bundles(targetId), "latest"] as const,
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/targets/{target_id}/bundles", {
          params: { path: { target_id: targetId }, query: { limit: 1, sort: "-version" } },
          signal,
        }),
      ),
    select: (page) => page.items[0] ?? null,
  });
}
