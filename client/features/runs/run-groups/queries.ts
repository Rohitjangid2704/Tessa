import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { polling } from "@/lib/api/polling";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import { RUN_GROUP_PLANS_LIMIT } from "./schemas";

export const RUN_GROUP_MEMBERS_PAGE_SIZE = 50;

const NOT_FOUND_STATUSES: readonly number[] = [404, 422];

export function isRunGroupNotFound(error: unknown): boolean {
  return isApiError(error) && NOT_FOUND_STATUSES.includes(error.status);
}

export function runGroupQuery(runGroupId: string) {
  return queryOptions({
    queryKey: qk.runGroups.detail(runGroupId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/run-groups/{run_group_id}", {
          params: { path: { run_group_id: runGroupId } },
          signal,
        }),
      ),
    ...polling.run,
  });
}

export function runGroupPlansQuery(targetId: string) {
  return queryOptions({
    queryKey: qk.plans.list({
      scope: "run-group",
      target_id: targetId,
      saved: true,
      limit: RUN_GROUP_PLANS_LIMIT,
    }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/plans", {
          params: {
            query: { target_id: targetId, saved: true, limit: RUN_GROUP_PLANS_LIMIT },
          },
          signal,
        }),
      ),
  });
}
