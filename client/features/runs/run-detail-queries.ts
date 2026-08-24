import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import { fetchRunEventsPage } from "./run-event-pages";

const NOT_FOUND_STATUSES: readonly number[] = [404, 422];

export function isRunNotFound(error: unknown): boolean {
  return isApiError(error) && NOT_FOUND_STATUSES.includes(error.status);
}

export function runQuery(runId: string) {
  return queryOptions({
    queryKey: qk.runs.detail(runId),
    queryFn: ({ signal }) =>
      unwrap(api.GET("/api/v1/runs/{run_id}", { params: { path: { run_id: runId } }, signal })),
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function runEventsTailQuery(runId: string) {
  return queryOptions({
    queryKey: qk.runs.eventsTail(runId),
    queryFn: ({ signal }) => fetchRunEventsPage(runId, { signal }),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function runBrowserSessionsQuery(runId: string) {
  return queryOptions({
    queryKey: qk.runs.browserSessions(runId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/runs/{run_id}/browser-sessions", {
          params: { path: { run_id: runId } },
          signal,
        }),
      ),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
