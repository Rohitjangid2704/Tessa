import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { useIdempotencyKey } from "@/lib/api/idempotency";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { unwrap } from "@/lib/api/unwrap";

export interface HelloRunInput {
  ticks: number;
  tick_interval_ms: number;
  include_laya: boolean;
}

export const HELLO_LIMITS = {
  ticks: { min: 1, max: 60, fallback: 5 },
  tickIntervalMs: { min: 100, max: 10_000, fallback: 1000 },
} as const;

const IDEMPOTENCY_CONFLICT_STATUS = 409;

export function useStartHelloRun() {
  const { key, rotate } = useIdempotencyKey();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (input: HelloRunInput) =>
      unwrap(
        api.POST("/api/v1/system/hello-runs", {
          params: { header: { "Idempotency-Key": key } },
          body: input,
        }),
      ),
    onSuccess: () => rotate(),
    onError: (error) => {
      if (isApiError(error) && error.status === IDEMPOTENCY_CONFLICT_STATUS) {
        rotate();
      }
    },
  });
}
