import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/api/query-keys";
import type { Scenario, ScenarioSummary, ScenarioSummaryPage } from "@/lib/api/types";

type ScenarioPages = InfiniteData<ScenarioSummaryPage, string | null>;

function mergeSummary(item: ScenarioSummary, scenario: Scenario): ScenarioSummary {
  return {
    ...item,
    title: scenario.title,
    family: scenario.family,
    feature_id: scenario.feature_id,
    status: scenario.status,
    version: scenario.version,
    synthetic: scenario.synthetic,
    validation: scenario.validation,
    provenance: scenario.provenance,
    updated_at: scenario.updated_at,
  };
}

function patchPages(data: ScenarioPages | undefined, scenario: Scenario): ScenarioPages | undefined {
  if (data === undefined) {
    return data;
  }
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (item.id === scenario.id ? mergeSummary(item, scenario) : item)),
    })),
  };
}

export function applyScenarioToCache(queryClient: QueryClient, scenario: Scenario): void {
  queryClient.setQueryData(qk.scenarios.detail(scenario.id), scenario);
  queryClient.setQueriesData<ScenarioPages>({ queryKey: qk.scenarios.lists() }, (data) =>
    patchPages(data, scenario),
  );
}

export function invalidateScenarioViews(queryClient: QueryClient, scenarioId: string): void {
  void queryClient.invalidateQueries({ queryKey: qk.scenarios.lists() });
  void queryClient.invalidateQueries({ queryKey: qk.scenarios.versions(scenarioId) });
  void queryClient.invalidateQueries({ queryKey: qk.scenarios.provenance(scenarioId) });
  void queryClient.invalidateQueries({ queryKey: qk.coverage.all() });
}
