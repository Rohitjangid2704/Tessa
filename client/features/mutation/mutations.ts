import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFingerprintedKey } from "@/features/plans/use-fingerprinted-key";
import { useStartRun } from "@/features/runs/start-mutation";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { RunHandle } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";
import type { MutantCreate, MutantUpdate, MutationRunCreate } from "./types";

interface KeyedBody {
  body: MutantCreate;
  idempotencyKey: string;
}

export interface UpdateMutantVariables {
  mutantId: string;
  update: MutantUpdate;
}

export interface CreateMutantOptions {
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

export function useCreateMutant() {
  const queryClient = useQueryClient();
  const idempotency = useFingerprintedKey();
  const mutation = useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ body, idempotencyKey }: KeyedBody) =>
      unwrap(
        api.POST("/api/v1/mutants", {
          params: { header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    onSuccess: () => {
      idempotency.forget();
      void queryClient.invalidateQueries({ queryKey: qk.mutants.all() });
    },
    onError: (error) => {
      if (isApiError(error) && error.isClientError) {
        idempotency.forget();
      }
    },
  });

  function create(body: MutantCreate, options: CreateMutantOptions = {}): void {
    mutation.mutate(
      { body, idempotencyKey: idempotency.keyFor(body) },
      { onSuccess: options.onSuccess, onError: options.onError },
    );
  }

  return { create, isPending: mutation.isPending, error: mutation.error, reset: mutation.reset };
}

export function useUpdateMutant() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ mutantId, update }: UpdateMutantVariables) =>
      unwrap(
        api.PATCH("/api/v1/mutants/{mutant_id}", {
          params: { path: { mutant_id: mutantId } },
          body: update,
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.mutants.all() });
      void queryClient.invalidateQueries({ queryKey: qk.mutation.all() });
    },
  });
}

export function useDeleteMutant() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: async (mutantId: string) => {
      await unwrap(
        api.DELETE("/api/v1/mutants/{mutant_id}", {
          params: { path: { mutant_id: mutantId } },
        }),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.mutants.all() });
      void queryClient.invalidateQueries({ queryKey: qk.mutation.all() });
    },
  });
}

export interface StartMutationRunOptions {
  onStarted?: (handle: RunHandle) => void;
}

export function useStartMutationRun(options: StartMutationRunOptions = {}) {
  const queryClient = useQueryClient();
  return useStartRun<MutationRunCreate>(
    (body, idempotencyKey) =>
      unwrap(
        api.POST("/api/v1/mutation-runs", {
          params: { header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    {
      navigate: false,
      onStarted: (handle) => {
        void queryClient.invalidateQueries({ queryKey: qk.mutation.all() });
        void queryClient.invalidateQueries({ queryKey: qk.mutants.all() });
        options.onStarted?.(handle);
      },
    },
  );
}
