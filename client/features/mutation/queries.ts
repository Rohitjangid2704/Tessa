import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { polling } from "@/lib/api/polling";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import {
  MUTANT_PAGE_SIZE,
  MUTANT_SCHEMA_NAME,
  MUTANT_SCHEMA_STALE_TIME_MS,
  MUTANT_SCHEMA_VERSION,
  RUN_HISTORY_PAGE_SIZE,
} from "./schemas";

export function mutantsQuery(targetId: string) {
  return cursorInfiniteOptions({
    queryKey: qk.mutants.list(targetId, { limit: MUTANT_PAGE_SIZE }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/mutants", {
          params: {
            query: {
              target_id: targetId,
              cursor,
              limit: MUTANT_PAGE_SIZE,
              include_total: true,
              sort: "created_at",
            },
          },
          signal,
        }),
      ),
  });
}

export function mutationRunsQuery(targetId: string, mutantId: string | null = null) {
  return cursorInfiniteOptions({
    queryKey: [...qk.mutation.runs(targetId, mutantId), { limit: RUN_HISTORY_PAGE_SIZE }] as const,
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/mutation-runs", {
          params: {
            query: {
              target_id: targetId,
              mutant_id: mutantId,
              cursor,
              limit: RUN_HISTORY_PAGE_SIZE,
              include_total: true,
            },
          },
          signal,
        }),
      ),
  });
}

export function mutationRunQuery(mutationRunId: string) {
  return queryOptions({
    queryKey: qk.mutation.run(mutationRunId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/mutation-runs/{mutation_run_id}", {
          params: { path: { mutation_run_id: mutationRunId } },
          signal,
        }),
      ),
    meta: INLINE_ERROR_META,
    ...polling.run,
  });
}

export function mutantSchemaQuery() {
  return queryOptions({
    queryKey: qk.system.schema(MUTANT_SCHEMA_NAME, MUTANT_SCHEMA_VERSION),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/schemas/{name}.v{version}.json", {
          params: { path: { name: MUTANT_SCHEMA_NAME, version: MUTANT_SCHEMA_VERSION } },
          signal,
        }),
      ) as Promise<unknown>,
    staleTime: MUTANT_SCHEMA_STALE_TIME_MS,
    meta: INLINE_ERROR_META,
  });
}
