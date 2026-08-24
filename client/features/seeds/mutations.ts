import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";

export interface VerifySeedVariables {
  seedId: string;
  idempotencyKey: string;
}

export interface ResetSeedVariables extends VerifySeedVariables {
  confirmTargetName: string;
}

function refreshAfterStart(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.seeds.all() });
  void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
}

export function useVerifySeed(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ seedId, idempotencyKey }: VerifySeedVariables) =>
      unwrap(
        api.POST("/api/v1/targets/{target_id}/seeds/verify", {
          params: { path: { target_id: targetId }, header: { "Idempotency-Key": idempotencyKey } },
          body: { seed_id: seedId },
        }),
      ),
    onSuccess: () => refreshAfterStart(queryClient),
  });
}

export function useResetSeed(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ seedId, idempotencyKey, confirmTargetName }: ResetSeedVariables) =>
      unwrap(
        api.POST("/api/v1/targets/{target_id}/seeds/reset", {
          params: { path: { target_id: targetId }, header: { "Idempotency-Key": idempotencyKey } },
          body: { seed_id: seedId, confirm_target_name: confirmTargetName },
        }),
      ),
    onSuccess: () => refreshAfterStart(queryClient),
  });
}
