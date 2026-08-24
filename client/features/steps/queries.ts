import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";

const NOT_FOUND_STATUSES: readonly number[] = [404, 422];

export function isStepNotFound(error: unknown): boolean {
  return isApiError(error) && NOT_FOUND_STATUSES.includes(error.status);
}

export function stepQuery(stepId: string) {
  return queryOptions({
    queryKey: qk.steps.detail(stepId),
    queryFn: ({ signal }) =>
      unwrap(api.GET("/api/v1/steps/{step_id}", { params: { path: { step_id: stepId } }, signal })),
    refetchOnWindowFocus: false,
    meta: INLINE_ERROR_META,
  });
}
