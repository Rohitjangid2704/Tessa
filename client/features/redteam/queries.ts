import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { AttackOutcome } from "@/lib/api/types";

export const REDTEAM_FAMILIES_STALE_TIME_MS = 10 * 60 * 1000;
export const ROUNDS_PAGE_LIMIT = 200;
export const ATTACKS_PAGE_SIZE = 25;
export const REDTEAM_POLL_INTERVAL_MS = 2000;

export interface AttackFilters {
  outcome?: AttackOutcome[];
  family?: string[];
  round_id?: string;
}

export function redteamFamiliesQuery() {
  return queryOptions({
    queryKey: qk.redteam.families(),
    queryFn: ({ signal }) => unwrap(api.GET("/api/v1/redteam/families", { signal })),
    select: (list) => list.items,
    staleTime: REDTEAM_FAMILIES_STALE_TIME_MS,
  });
}

export function redteamRoundsQuery(runId: string, pollMs: number | false = false) {
  return queryOptions({
    queryKey: qk.redteam.rounds(runId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/redteam-rounds", {
          params: { query: { run_id: runId, limit: ROUNDS_PAGE_LIMIT } },
          signal,
        }),
      ),
    select: (page) => [...page.items].sort((left, right) => left.index - right.index),
    staleTime: 0,
    refetchInterval: pollMs,
  });
}

export function attacksQuery(
  runId: string,
  filters: AttackFilters = {},
  pollMs: number | false = false,
) {
  return {
    ...cursorInfiniteOptions({
      queryKey: qk.attacks.list(runId, { ...filters, limit: ATTACKS_PAGE_SIZE }),
      staleTime: 0,
      fetchPage: ({ cursor, signal }) =>
        unwrap(
          api.GET("/api/v1/attacks", {
            params: {
              query: {
                run_id: runId,
                ...filters,
                cursor,
                limit: ATTACKS_PAGE_SIZE,
                include_total: true,
              },
            },
            signal,
          }),
        ),
    }),
    refetchInterval: pollMs,
  };
}
