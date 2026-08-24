import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { isRunTerminal, polling } from "@/lib/api/polling";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { ReplayReasonCode, ReplayRecordStatus } from "@/lib/api/types";

export const REPLAYS_PAGE_SIZE = 25;
export const REPLAY_RECORDS_PAGE_SIZE = 50;
export const REPLAY_LIST_POLL_MS = 2500;

export interface ReplayRecordFilters {
  status?: ReplayRecordStatus[];
  reason_code?: ReplayReasonCode[];
}

function hasActiveReplay(data: unknown): boolean {
  if (typeof data !== "object" || data === null || !("pages" in data)) {
    return false;
  }
  const { pages } = data;
  if (!Array.isArray(pages)) {
    return false;
  }
  return pages.some((page: unknown) => {
    if (typeof page !== "object" || page === null || !("items" in page)) {
      return false;
    }
    const { items } = page;
    return Array.isArray(items) && items.some((item: unknown) => !isRunTerminal(item));
  });
}

export function replaysListQuery(pageSize = REPLAYS_PAGE_SIZE) {
  return {
    ...cursorInfiniteOptions({
      queryKey: qk.replays.list({ limit: pageSize }),
      staleTime: 0,
      fetchPage: ({ cursor, signal }) =>
        unwrap(
          api.GET("/api/v1/replays", {
            params: { query: { cursor, limit: pageSize, include_total: true } },
            signal,
          }),
        ),
    }),
    refetchInterval: (query: { state: { data: unknown } }) =>
      hasActiveReplay(query.state.data) ? REPLAY_LIST_POLL_MS : false,
    refetchIntervalInBackground: false,
  };
}

export function replayQuery(replayId: string) {
  return {
    ...queryOptions({
      queryKey: qk.replays.detail(replayId),
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/api/v1/replays/{replay_id}", {
            params: { path: { replay_id: replayId } },
            signal,
          }),
        ),
      staleTime: 0,
    }),
    ...polling.run,
  };
}

export function replayRecordsQuery(
  replayId: string,
  filters: ReplayRecordFilters = {},
  pollMs: number | false = false,
) {
  return {
    ...cursorInfiniteOptions({
      queryKey: qk.replays.records(replayId, { ...filters, limit: REPLAY_RECORDS_PAGE_SIZE }),
      staleTime: 0,
      fetchPage: ({ cursor, signal }) =>
        unwrap(
          api.GET("/api/v1/replays/{replay_id}/records", {
            params: {
              path: { replay_id: replayId },
              query: { ...filters, cursor, limit: REPLAY_RECORDS_PAGE_SIZE, include_total: true },
            },
            signal,
          }),
        ),
    }),
    refetchInterval: pollMs,
  };
}
