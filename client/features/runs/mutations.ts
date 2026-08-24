import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";

export const RUN_NOT_CANCELABLE_CODE = "run_not_cancelable";

export function isRunNotCancelable(error: unknown): boolean {
  return isApiError(error) && error.status === 409 && error.code === RUN_NOT_CANCELABLE_CODE;
}

export function useCancelRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: () =>
      unwrap(api.POST("/api/v1/runs/{run_id}/cancel", { params: { path: { run_id: runId } } })),
    onSuccess: (run) => {
      queryClient.setQueryData(qk.runs.detail(run.id), run);
      void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
    },
    onError: (error) => {
      if (isRunNotCancelable(error)) {
        void queryClient.invalidateQueries({ queryKey: qk.runs.detail(runId) });
        void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
      }
    },
  });
}

export const RUN_NOT_STOPPABLE_CODE = "run_not_stoppable";

export function isRunNotStoppable(error: unknown): boolean {
  return isApiError(error) && error.status === 409 && error.code === RUN_NOT_STOPPABLE_CODE;
}

export function useStopRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: () =>
      unwrap(api.POST("/api/v1/runs/{run_id}/stop", { params: { path: { run_id: runId } } })),
    onSuccess: (run) => {
      queryClient.setQueryData(qk.runs.detail(run.id), run);
      void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
    },
    onError: (error) => {
      if (isRunNotStoppable(error)) {
        void queryClient.invalidateQueries({ queryKey: qk.runs.detail(runId) });
        void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
      }
    },
  });
}
