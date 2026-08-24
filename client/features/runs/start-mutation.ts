import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useFingerprintedKey } from "@/features/plans/use-fingerprinted-key";
import { isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { RunHandle } from "@/lib/api/types";
import { runRoutes } from "@/lib/routes";

export type StartRunRequest<Body> = (body: Body, idempotencyKey: string) => Promise<RunHandle>;

interface KeyedBody<Body> {
  body: Body;
  idempotencyKey: string;
}

export interface StartRunCallbacks {
  onError?: (error: unknown) => void;
}

export interface StartRunOptions {
  navigate?: boolean;
  onStarted?: (handle: RunHandle) => void;
}

export function useStartRun<Body>(request: StartRunRequest<Body>, options: StartRunOptions = {}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const idempotency = useFingerprintedKey();
  const { navigate = true, onStarted } = options;

  const mutation = useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ body, idempotencyKey }: KeyedBody<Body>) => request(body, idempotencyKey),
    onSuccess: (handle) => {
      idempotency.forget();
      void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
      onStarted?.(handle);
      if (navigate) {
        router.push(runRoutes.detail(handle.run_id));
      }
    },
    onError: (error) => {
      if (isApiError(error) && error.isClientError) {
        idempotency.forget();
      }
    },
  });

  function start(body: Body, callbacks: StartRunCallbacks = {}): void {
    mutation.mutate(
      { body, idempotencyKey: idempotency.keyFor(body) },
      { onError: callbacks.onError },
    );
  }

  return { start, isPending: mutation.isPending, error: mutation.error, reset: mutation.reset };
}
