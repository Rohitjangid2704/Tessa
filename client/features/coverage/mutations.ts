import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFingerprintedKey } from "@/features/plans/use-fingerprinted-key";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { Budget, CoverageGenerateCreate, Depth, RunHandle } from "./types";

export interface GenerateInput {
  planId: string;
  cellIds: readonly string[];
  depth: Depth;
  budget?: Budget;
}

export interface GenerateOptions {
  onSuccess?: (handle: RunHandle) => void;
}

interface KeyedBody {
  body: CoverageGenerateCreate;
  idempotencyKey: string;
}

export function buildGenerateBody(input: GenerateInput): CoverageGenerateCreate {
  const body: CoverageGenerateCreate = {
    plan_id: input.planId,
    cell_ids: [...input.cellIds],
    depth: input.depth,
  };
  return input.budget === undefined ? body : { ...body, budget: input.budget };
}

export function useGenerateCoverage() {
  const queryClient = useQueryClient();
  const idempotency = useFingerprintedKey();
  const mutation = useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ body, idempotencyKey }: KeyedBody) =>
      unwrap(
        api.POST("/api/v1/coverage/generate", {
          params: { header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    onSuccess: () => {
      idempotency.forget();
      void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
    },
    onError: (error) => {
      if (isApiError(error) && error.isClientError) {
        idempotency.forget();
      }
    },
  });

  function generate(input: GenerateInput, options: GenerateOptions = {}): void {
    const body = buildGenerateBody(input);
    mutation.mutate(
      { body, idempotencyKey: idempotency.keyFor(body) },
      { onSuccess: options.onSuccess },
    );
  }

  return {
    generate,
    isPending: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
  };
}
