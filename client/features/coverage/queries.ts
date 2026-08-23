import { queryOptions } from "@tanstack/react-query";
import { runQuery } from "@/features/runs/run-detail-queries";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { polling } from "@/lib/api/polling";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { RunStatus } from "@/lib/api/types";
import { ACTIVE_GENERATION_RUN_LIMIT, COVERAGE_SCENARIOS_PAGE_SIZE } from "./schemas";
import type { GenerationProgressPayload } from "./types";

export const COVERAGE_STALE_TIME_MS = 15_000;

const ACTIVE_RUN_STATUSES: RunStatus[] = ["queued", "planning", "running", "canceling"];

export interface CoverageScope {
  targetId: string;
  planId: string | null;
}

export function coverageQuery({ targetId, planId }: CoverageScope) {
  return queryOptions({
    queryKey: qk.coverage.map(targetId, planId, {}),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/coverage", {
          params: { query: { target_id: targetId, plan_id: planId ?? undefined } },
          signal,
        }),
      ),
    staleTime: COVERAGE_STALE_TIME_MS,
    meta: INLINE_ERROR_META,
  });
}

export function generationProgressQuery(runId: string) {
  return queryOptions({
    queryKey: qk.generation.run(runId),
    queryFn: (): Promise<GenerationProgressPayload> =>
      Promise.reject(new Error("Generation progress arrives through the coverage feed")),
    enabled: false,
    staleTime: Infinity,
  });
}

export function generationRunQuery(runId: string) {
  return { ...runQuery(runId), ...polling.run };
}

export function activeGenerationRunsQuery(targetId: string) {
  return queryOptions({
    queryKey: qk.runs.list({
      target_id: targetId,
      kind: ["generate"],
      status: ACTIVE_RUN_STATUSES,
      limit: ACTIVE_GENERATION_RUN_LIMIT,
    }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/runs", {
          params: {
            query: {
              target_id: targetId,
              kind: ["generate"],
              status: ACTIVE_RUN_STATUSES,
              limit: ACTIVE_GENERATION_RUN_LIMIT,
            },
          },
          signal,
        }),
      ),
    select: (page) => page.items,
    meta: INLINE_ERROR_META,
  });
}

export function cellScenariosQuery(targetId: string, cellId: string) {
  return cursorInfiniteOptions({
    queryKey: qk.scenarios.list({
      target_id: targetId,
      cell_id: cellId,
      limit: COVERAGE_SCENARIOS_PAGE_SIZE,
    }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/scenarios", {
          params: {
            query: {
              target_id: targetId,
              cell_id: cellId,
              cursor,
              limit: COVERAGE_SCENARIOS_PAGE_SIZE,
              include_total: true,
            },
          },
          signal,
        }),
      ),
  });
}
