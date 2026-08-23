import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import { HEALTH_CHECK_TIMEOUT_MS } from "./schemas";
import type { EnvironmentPatch } from "./types";

export function useSaveEnvironment(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    meta: INLINE_ERROR_META,
    mutationFn: (patch: EnvironmentPatch) =>
      unwrap(
        api.PATCH("/api/v1/targets/{target_id}/environment", {
          params: { path: { target_id: targetId } },
          body: patch,
        }),
      ),
    onSuccess: (list) => {
      queryClient.setQueryData(qk.targets.environment(targetId), list);
      void queryClient.invalidateQueries({ queryKey: qk.targets.health(targetId) });
    },
  });
}

export function useRunHealthChecks(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/targets/{target_id}/health-checks", {
          params: { path: { target_id: targetId } },
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        }),
      ),
    onSuccess: (report) => {
      queryClient.setQueryData(qk.targets.health(targetId), report);
      void queryClient.invalidateQueries({ queryKey: qk.targets.environment(targetId) });
      void queryClient.invalidateQueries({ queryKey: qk.targets.lists() });
    },
  });
}
