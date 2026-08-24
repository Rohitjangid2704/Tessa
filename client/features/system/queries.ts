import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";

export const HEALTH_REFETCH_INTERVAL_MS = 30_000;
export const DEPENDENCY_REFETCH_INTERVAL_MS = 30_000;
export const SCHEMA_INDEX_STALE_TIME_MS = 60 * 60 * 1000;
export const ME_STALE_TIME_MS = 60_000;

export function meQuery() {
  return queryOptions({
    queryKey: qk.me(),
    queryFn: ({ signal }) => unwrap(api.GET("/api/v1/users/me", { signal })),
    staleTime: ME_STALE_TIME_MS,
    refetchOnWindowFocus: true,
  });
}

export function healthQuery() {
  return queryOptions({
    queryKey: qk.system.health(),
    queryFn: ({ signal }) => unwrap(api.GET("/health", { signal })),
    meta: INLINE_ERROR_META,
    refetchInterval: HEALTH_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export function dependencyHealthQuery() {
  return queryOptions({
    queryKey: qk.system.dependencies(),
    queryFn: ({ signal }) => unwrap(api.GET("/health/dependencies", { signal })),
    meta: INLINE_ERROR_META,
    refetchInterval: DEPENDENCY_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export function schemaIndexQuery() {
  return queryOptions({
    queryKey: qk.system.schemas(),
    queryFn: ({ signal }) => unwrap(api.GET("/schemas/index.json", { signal })),
    meta: INLINE_ERROR_META,
    staleTime: SCHEMA_INDEX_STALE_TIME_MS,
  });
}
