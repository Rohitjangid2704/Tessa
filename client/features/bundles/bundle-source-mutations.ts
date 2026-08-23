import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useStartRun } from "@/features/runs/start-mutation";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { BundleImportCreate, BundleSource, BundleSourceSet } from "@/lib/api/types";

export function usePutBundleSource(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (body: BundleSourceSet) =>
      unwrap(
        api.PUT("/api/v1/targets/{target_id}/bundle-source", {
          params: { path: { target_id: targetId } },
          body,
        }),
      ),
    onSuccess: (source) => {
      queryClient.setQueryData<BundleSource | null>(qk.bundleSource(targetId), source);
    },
  });
}

export function usePullBundle(targetId: string) {
  const queryClient = useQueryClient();
  return useStartRun<BundleImportCreate>(
    (body, idempotencyKey) =>
      unwrap(
        api.POST("/api/v1/targets/{target_id}/bundle-source/pull", {
          params: {
            path: { target_id: targetId },
            header: { "Idempotency-Key": idempotencyKey },
          },
          body,
        }),
      ),
    {
      onStarted: () => {
        void queryClient.invalidateQueries({ queryKey: qk.bundleSource(targetId) });
      },
    },
  );
}
