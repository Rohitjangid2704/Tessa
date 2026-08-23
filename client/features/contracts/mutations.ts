import { useQueryClient } from "@tanstack/react-query";
import { useStartRun, type StartRunOptions } from "@/features/runs/start-mutation";
import { api } from "@/lib/api/client";
import { qk } from "@/lib/api/query-keys";
import type { ContractCheckCreate } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

function postContractCheck(body: ContractCheckCreate, idempotencyKey: string) {
  return unwrap(
    api.POST("/api/v1/contract-checks", {
      params: { header: { "Idempotency-Key": idempotencyKey } },
      body,
    }),
  );
}

export function useStartContractCheck(options: StartRunOptions = {}) {
  const queryClient = useQueryClient();
  const { onStarted, ...rest } = options;
  return useStartRun<ContractCheckCreate>(postContractCheck, {
    ...rest,
    onStarted: (handle) => {
      void queryClient.invalidateQueries({ queryKey: qk.contracts.lists() });
      onStarted?.(handle);
    },
  });
}
