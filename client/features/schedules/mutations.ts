import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFingerprintedKey } from "@/features/plans/use-fingerprinted-key";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { useIdempotencyKey } from "@/lib/api/idempotency";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { Schedule, ScheduleCreate, ScheduleUpdate } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

interface KeyedBody {
  body: ScheduleCreate;
  idempotencyKey: string;
}

export interface CreateScheduleOptions {
  onSuccess?: (schedule: Schedule) => void;
  onError?: (error: unknown) => void;
}

export function useCreateSchedule() {
  const queryClient = useQueryClient();
  const idempotency = useFingerprintedKey();
  const mutation = useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ body, idempotencyKey }: KeyedBody) =>
      unwrap(
        api.POST("/api/v1/schedules", {
          params: { header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    onSuccess: (schedule) => {
      idempotency.forget();
      queryClient.setQueryData(qk.schedules.detail(schedule.id), schedule);
      void queryClient.invalidateQueries({ queryKey: qk.schedules.lists() });
      void queryClient.invalidateQueries({ queryKey: qk.plans.lists() });
    },
    onError: (error) => {
      if (isApiError(error) && error.isClientError) {
        idempotency.forget();
      }
    },
  });

  function create(body: ScheduleCreate, options: CreateScheduleOptions = {}): void {
    mutation.mutate(
      { body, idempotencyKey: idempotency.keyFor(body) },
      { onSuccess: options.onSuccess, onError: options.onError },
    );
  }

  return { create, isPending: mutation.isPending, error: mutation.error, reset: mutation.reset };
}

export interface UpdateScheduleVariables {
  scheduleId: string;
  update: ScheduleUpdate;
}

export function useUpdateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ scheduleId, update }: UpdateScheduleVariables) =>
      unwrap(
        api.PATCH("/api/v1/schedules/{schedule_id}", {
          params: { path: { schedule_id: scheduleId } },
          body: update,
        }),
      ),
    onSuccess: (schedule) => {
      queryClient.setQueryData(qk.schedules.detail(schedule.id), schedule);
      void queryClient.invalidateQueries({ queryKey: qk.schedules.lists() });
    },
  });
}

export function useDeleteSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: async (scheduleId: string) => {
      await unwrap(
        api.DELETE("/api/v1/schedules/{schedule_id}", {
          params: { path: { schedule_id: scheduleId } },
        }),
      );
    },
    onSuccess: (_result, scheduleId) => {
      queryClient.removeQueries({ queryKey: qk.schedules.detail(scheduleId) });
      void queryClient.invalidateQueries({ queryKey: qk.schedules.lists() });
      void queryClient.invalidateQueries({ queryKey: qk.plans.lists() });
    },
  });
}

export function useRunScheduleNow(scheduleId: string) {
  const queryClient = useQueryClient();
  const idempotency = useIdempotencyKey();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/schedules/{schedule_id}/run-now", {
          params: {
            path: { schedule_id: scheduleId },
            header: { "Idempotency-Key": idempotency.key },
          },
        }),
      ),
    onSuccess: () => {
      idempotency.rotate();
      void queryClient.invalidateQueries({ queryKey: qk.schedules.lists() });
      void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
    },
    onError: (error) => {
      if (isApiError(error) && error.isClientError) {
        idempotency.rotate();
      }
    },
  });
}
