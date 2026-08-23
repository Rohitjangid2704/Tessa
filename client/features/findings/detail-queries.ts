import { queryOptions, skipToken } from "@tanstack/react-query";
import type { PromptIssue } from "@/features/prompts/types";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";

export const OCCURRENCE_PAGE_SIZE = 25;
export const EXPLANATION_PAGE_SIZE = 10;

const NOT_FOUND_STATUSES: readonly number[] = [404, 422];
const FORBIDDEN_STATUS = 403;

export function isFindingNotFound(error: unknown): boolean {
  return isApiError(error) && NOT_FOUND_STATUSES.includes(error.status);
}

export function isFindingForbidden(error: unknown): boolean {
  return isApiError(error) && error.status === FORBIDDEN_STATUS;
}

export function findingDetailQuery(findingId: string) {
  return queryOptions({
    queryKey: qk.findings.detail(findingId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/findings/{finding_id}", {
          params: { path: { finding_id: findingId } },
          signal,
        }),
      ),
    refetchOnWindowFocus: false,
    meta: INLINE_ERROR_META,
  });
}

export function findingReproQuery(findingId: string) {
  return queryOptions({
    queryKey: qk.findings.repro(findingId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/findings/{finding_id}/repro", {
          params: { path: { finding_id: findingId } },
          signal,
        }),
      ),
    refetchOnWindowFocus: false,
    meta: INLINE_ERROR_META,
  });
}

export function findingOccurrencesOptions(findingId: string) {
  return cursorInfiniteOptions({
    queryKey: [...qk.findings.occurrences(findingId), { pageSize: OCCURRENCE_PAGE_SIZE }] as const,
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/findings/{finding_id}/occurrences", {
          params: {
            path: { finding_id: findingId },
            query: { cursor, limit: OCCURRENCE_PAGE_SIZE, include_total: true },
          },
          signal,
        }),
      ),
  });
}

export function findingExplanationsOptions(findingId: string) {
  return cursorInfiniteOptions({
    queryKey: [
      ...qk.findings.explanations(findingId),
      { pageSize: EXPLANATION_PAGE_SIZE },
    ] as const,
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/findings/{finding_id}/explanations", {
          params: {
            path: { finding_id: findingId },
            query: { cursor, limit: EXPLANATION_PAGE_SIZE, include_total: true },
          },
          signal,
        }),
      ),
  });
}

export function explainPromptQuery(findingId: string) {
  return queryOptions<PromptIssue, Error, PromptIssue, ReturnType<typeof qk.promptIssues.explain>>({
    queryKey: qk.promptIssues.explain(findingId),
    queryFn: skipToken,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
