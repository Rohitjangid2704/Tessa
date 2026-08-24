import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { ScenarioOrigin, ScenarioStatus } from "@/lib/api/types";
import type { ScenarioFilterValues } from "./schemas";

export const SCENARIOS_PAGE_SIZE = 25;

const NOT_FOUND_STATUSES: readonly number[] = [404, 422];

export interface ScenarioListFilters {
  target_id?: string;
  q?: string;
  status?: ScenarioStatus[];
  origin?: ScenarioOrigin[];
  family?: string[];
  feature_id?: string[];
  include_synthetic?: boolean;
  replay_id?: string;
  sort?: string;
}

export function toScenarioListFilters(values: ScenarioFilterValues): ScenarioListFilters {
  return {
    target_id: values.target_id,
    q: values.q,
    status: values.status,
    origin: values.origin,
    family: values.family === undefined ? undefined : [values.family],
    feature_id: values.feature_id === undefined ? undefined : [values.feature_id],
    include_synthetic: values.include_synthetic,
    sort: values.sort,
  };
}

export function scenariosListQuery(
  filters: ScenarioListFilters = {},
  pageSize = SCENARIOS_PAGE_SIZE,
) {
  return cursorInfiniteOptions({
    queryKey: qk.scenarios.list({ ...filters, limit: pageSize }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/scenarios", {
          params: { query: { ...filters, cursor, limit: pageSize, include_total: true } },
          signal,
        }),
      ),
  });
}

export function scenarioQuery(scenarioId: string) {
  return queryOptions({
    queryKey: qk.scenarios.detail(scenarioId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/scenarios/{scenario_id}", {
          params: { path: { scenario_id: scenarioId } },
          signal,
        }),
      ),
  });
}

export function isScenarioNotFound(error: unknown): boolean {
  return isApiError(error) && NOT_FOUND_STATUSES.includes(error.status);
}

export const SCENARIO_VERSIONS_LIMIT = 100;

export const VALIDATION_GC_TIME_MS = 60_000;

export function scenarioVersionsQuery(scenarioId: string) {
  return queryOptions({
    queryKey: qk.scenarios.versions(scenarioId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/scenarios/{scenario_id}/versions", {
          params: {
            path: { scenario_id: scenarioId },
            query: { limit: SCENARIO_VERSIONS_LIMIT, sort: "-version" },
          },
          signal,
        }),
      ),
    select: (page) => page.items,
  });
}

export function scenarioProvenanceQuery(scenarioId: string) {
  return queryOptions({
    queryKey: qk.scenarios.provenance(scenarioId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/scenarios/{scenario_id}/provenance", {
          params: { path: { scenario_id: scenarioId } },
          signal,
        }),
      ),
  });
}

export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}-${text.length}`;
}

export function scenarioValidationQuery(targetId: string, yaml: string) {
  return queryOptions({
    queryKey: qk.scenarios.validate(`${targetId}:${hashText(yaml)}`),
    queryFn: ({ signal }) =>
      unwrap(
        api.POST("/api/v1/scenarios/validate", {
          body: { target_id: targetId, yaml },
          signal,
        }),
      ),
    staleTime: 0,
    gcTime: VALIDATION_GC_TIME_MS,
    retry: false,
  });
}

export function reviewQueueFilters(
  targetId?: string,
  origin?: ScenarioOrigin[],
  replayId?: string,
): ScenarioListFilters {
  return {
    target_id: targetId,
    status: ["in_review"],
    origin,
    replay_id: replayId,
    sort: "created_at",
  };
}

export function reviewCountFilters(targetId?: string): ScenarioListFilters {
  return { target_id: targetId, status: ["in_review"] };
}
