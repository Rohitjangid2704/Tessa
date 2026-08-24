import { queryOptions, skipToken } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import { PREVIEW_STALE_TIME_MS, SAVED_PLANS_PAGE_SIZE } from "./schemas";
import type { PlanCreate } from "./types";

const NO_PLAN = {} as const;

export function planPreviewQuery(body: PlanCreate | null) {
  return queryOptions({
    queryKey: qk.plans.preview(body ?? NO_PLAN),
    queryFn:
      body === null
        ? skipToken
        : ({ signal }) => unwrap(api.POST("/api/v1/plans/preview", { body, signal })),
    staleTime: PREVIEW_STALE_TIME_MS,
    meta: INLINE_ERROR_META,
  });
}

export function planQuery(planId: string) {
  return queryOptions({
    queryKey: qk.plans.detail(planId),
    queryFn: ({ signal }) =>
      unwrap(api.GET("/api/v1/plans/{plan_id}", { params: { path: { plan_id: planId } }, signal })),
    meta: INLINE_ERROR_META,
  });
}

export function savedPlansQuery(targetId: string, pageSize = SAVED_PLANS_PAGE_SIZE) {
  return cursorInfiniteOptions({
    queryKey: qk.plans.list({ target_id: targetId, saved: true, limit: pageSize }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/plans", {
          params: {
            query: {
              target_id: targetId,
              saved: true,
              cursor,
              limit: pageSize,
              include_total: true,
            },
          },
          signal,
        }),
      ),
  });
}
