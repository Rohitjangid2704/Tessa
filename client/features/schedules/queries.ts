import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import {
  SCHEDULE_SCHEMA_NAME,
  SCHEDULE_SCHEMA_STALE_TIME_MS,
  SCHEDULE_SCHEMA_VERSION,
  toScheduleFormSchemas,
} from "./schedule-schema";

export const SCHEDULES_PAGE_SIZE = 100;
export const SCHEDULE_PLANS_PAGE_SIZE = 100;

export interface SchedulesFilters {
  planId?: string | null;
}

export function schedulesQuery(filters: SchedulesFilters = {}) {
  const planId = filters.planId ?? null;
  return cursorInfiniteOptions({
    queryKey: qk.schedules.list(planId, { limit: SCHEDULES_PAGE_SIZE }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/schedules", {
          params: {
            query: {
              plan_id: planId,
              cursor,
              limit: SCHEDULES_PAGE_SIZE,
              include_total: true,
            },
          },
          signal,
        }),
      ),
  });
}

export function schedulePlansQuery(targetId: string | null) {
  return cursorInfiniteOptions({
    queryKey: qk.plans.list({
      for: "schedules",
      target_id: targetId,
      saved: true,
      limit: SCHEDULE_PLANS_PAGE_SIZE,
    }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/plans", {
          params: {
            query: {
              target_id: targetId,
              saved: true,
              cursor,
              limit: SCHEDULE_PLANS_PAGE_SIZE,
              include_total: true,
            },
          },
          signal,
        }),
      ),
  });
}

export function scheduleSchemaQuery() {
  return queryOptions({
    queryKey: qk.schedules.schema(),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/schemas/{name}.v{version}.json", {
          params: { path: { name: SCHEDULE_SCHEMA_NAME, version: SCHEDULE_SCHEMA_VERSION } },
          signal,
        }),
      ),
    select: toScheduleFormSchemas,
    staleTime: SCHEDULE_SCHEMA_STALE_TIME_MS,
    meta: INLINE_ERROR_META,
  });
}
