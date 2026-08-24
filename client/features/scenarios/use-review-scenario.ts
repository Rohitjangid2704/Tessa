import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { ReviewDecision, Scenario } from "@/lib/api/types";
import { applyScenarioToCache, invalidateScenarioViews } from "./cache";

export interface ReviewScenarioVariables {
  scenarioId: string;
  decision: ReviewDecision;
  note?: string;
}

export function isReviewConflict(error: unknown): boolean {
  return isApiError(error) && error.status === 409;
}

export function useReviewScenario() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ scenarioId, decision, note }: ReviewScenarioVariables) =>
      unwrap(
        api.POST("/api/v1/scenarios/{scenario_id}/review", {
          params: { path: { scenario_id: scenarioId } },
          body: decision === "accept" ? { decision } : { decision, note },
        }),
      ),
    onSuccess: (scenario: Scenario) => {
      applyScenarioToCache(queryClient, scenario);
      invalidateScenarioViews(queryClient, scenario.id);
    },
    onError: (error, { scenarioId }) => {
      if (isReviewConflict(error)) {
        void queryClient.invalidateQueries({ queryKey: qk.scenarios.detail(scenarioId) });
        void queryClient.invalidateQueries({ queryKey: qk.scenarios.lists() });
        void queryClient.invalidateQueries({ queryKey: qk.scenarios.provenance(scenarioId) });
      }
    },
  });
}
