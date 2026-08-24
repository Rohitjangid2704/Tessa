import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { Scenario, ScenarioPatchStatus } from "@/lib/api/types";
import { applyScenarioToCache, invalidateScenarioViews } from "./cache";

export const VERSION_CONFLICT_CODE = "version_conflict";

export function isVersionConflict(error: unknown): boolean {
  return isApiError(error) && error.status === 409 && error.code === VERSION_CONFLICT_CODE;
}

export interface SaveScenarioVariables {
  yaml: string;
  baseVersion: number;
}

export function useSaveScenario(scenarioId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ yaml, baseVersion }: SaveScenarioVariables) =>
      unwrap(
        api.PUT("/api/v1/scenarios/{scenario_id}", {
          params: { path: { scenario_id: scenarioId } },
          body: { yaml, base_version: baseVersion },
        }),
      ),
    onSuccess: (scenario: Scenario) => {
      applyScenarioToCache(queryClient, scenario);
      invalidateScenarioViews(queryClient, scenarioId);
    },
  });
}

export interface CreateScenarioVariables {
  targetId: string;
  yaml: string;
  idempotencyKey: string;
}

export function useCreateScenario() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ targetId, yaml, idempotencyKey }: CreateScenarioVariables) =>
      unwrap(
        api.POST("/api/v1/scenarios", {
          params: { header: { "Idempotency-Key": idempotencyKey } },
          body: { target_id: targetId, yaml },
        }),
      ),
    onSuccess: (scenario: Scenario) => {
      applyScenarioToCache(queryClient, scenario);
      invalidateScenarioViews(queryClient, scenario.id);
    },
  });
}

export interface ScenarioStatusVariables {
  status: ScenarioPatchStatus;
}

export function useScenarioStatus(scenarioId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ status }: ScenarioStatusVariables) =>
      unwrap(
        api.PATCH("/api/v1/scenarios/{scenario_id}", {
          params: { path: { scenario_id: scenarioId } },
          body: { status },
        }),
      ),
    onSuccess: (scenario: Scenario) => {
      applyScenarioToCache(queryClient, scenario);
      invalidateScenarioViews(queryClient, scenarioId);
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: qk.scenarios.detail(scenarioId) });
    },
  });
}
