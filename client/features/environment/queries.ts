import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";

export function environmentQuery(targetId: string) {
  return queryOptions({
    queryKey: qk.targets.environment(targetId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/targets/{target_id}/environment", {
          params: { path: { target_id: targetId } },
          signal,
        }),
      ),
    meta: INLINE_ERROR_META,
  });
}

export function healthReportQuery(targetId: string) {
  return queryOptions({
    queryKey: qk.targets.health(targetId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/targets/{target_id}/health", {
          params: { path: { target_id: targetId } },
          signal,
        }),
      ),
    meta: INLINE_ERROR_META,
  });
}
