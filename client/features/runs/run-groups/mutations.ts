import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useFingerprintedKey } from "@/features/plans/use-fingerprinted-key";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { RunGroup, RunGroupCreate } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";
import { runGroupRoutes } from "@/lib/routes";

interface KeyedBody {
  body: RunGroupCreate;
  idempotencyKey: string;
}

export interface StartRunGroupOptions {
  navigate?: boolean;
  onStarted?: (group: RunGroup) => void;
}

function postRunGroup(body: RunGroupCreate, idempotencyKey: string): Promise<RunGroup> {
  return unwrap(
    api.POST("/api/v1/run-groups", {
      params: { header: { "Idempotency-Key": idempotencyKey } },
      body,
    }),
  );
}

export function useStartRunGroup(options: StartRunGroupOptions = {}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const idempotency = useFingerprintedKey();
  const { navigate = true, onStarted } = options;

  const mutation = useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ body, idempotencyKey }: KeyedBody) => postRunGroup(body, idempotencyKey),
    onSuccess: (group) => {
      idempotency.forget();
      queryClient.setQueryData(qk.runGroups.detail(group.id), group);
      void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
      onStarted?.(group);
      if (navigate) {
        router.push(runGroupRoutes.detail(group.id));
      }
    },
    onError: (error) => {
      if (isApiError(error) && error.isClientError) {
        idempotency.forget();
      }
    },
  });

  function start(body: RunGroupCreate): void {
    mutation.mutate({ body, idempotencyKey: idempotency.keyFor(body) });
  }

  return { start, isPending: mutation.isPending, error: mutation.error, reset: mutation.reset };
}
