import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { RunKind, RunScenarioStatus, RunStatus, VerdictStatus } from "@/lib/api/types";

export const RUNS_PAGE_SIZE = 25;
export const RUN_SCENARIOS_PAGE_SIZE = 50;
export const RUN_SCENARIO_FACETS_LIMIT = 200;

export interface RunListFilters {
  target_id?: string;
  status?: RunStatus[];
  kind?: RunKind[];
  plan_id?: string;
  run_group_id?: string;
}

export interface RunScenarioFilters {
  status?: RunScenarioStatus[];
  verdict?: VerdictStatus[];
  family?: string[];
  role?: string[];
}

export interface RunScenarioFacets {
  families: string[];
  roles: string[];
}

export function runsListQuery(filters: RunListFilters = {}, pageSize = RUNS_PAGE_SIZE) {
  return cursorInfiniteOptions({
    queryKey: qk.runs.list({ ...filters, limit: pageSize }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/runs", {
          params: { query: { ...filters, cursor, limit: pageSize, include_total: true } },
          signal,
        }),
      ),
  });
}

export function runScenariosQuery(
  runId: string,
  filters: RunScenarioFilters = {},
  pageSize = RUN_SCENARIOS_PAGE_SIZE,
) {
  return cursorInfiniteOptions({
    queryKey: qk.runs.scenarios(runId, { ...filters, limit: pageSize }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/runs/{run_id}/scenarios", {
          params: {
            path: { run_id: runId },
            query: { ...filters, cursor, limit: pageSize, include_total: true },
          },
          signal,
        }),
      ),
  });
}

export function runScenarioQuery(runScenarioId: string) {
  return queryOptions({
    queryKey: qk.runScenarios.detail(runScenarioId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/run-scenarios/{run_scenario_id}", {
          params: { path: { run_scenario_id: runScenarioId } },
          signal,
        }),
      ),
  });
}

function distinctSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function selectFacets(page: {
  items: readonly { family: string; role: string }[];
}): RunScenarioFacets {
  return {
    families: distinctSorted(page.items.map((item) => item.family)),
    roles: distinctSorted(page.items.map((item) => item.role)),
  };
}

export function runScenarioFacetsQuery(runId: string, scenarioTotal: number) {
  return queryOptions({
    queryKey: qk.runs.scenarioFacets(runId, scenarioTotal),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/runs/{run_id}/scenarios", {
          params: { path: { run_id: runId }, query: { limit: RUN_SCENARIO_FACETS_LIMIT } },
          signal,
        }),
      ),
    select: selectFacets,
    enabled: scenarioTotal > 0,
  });
}
