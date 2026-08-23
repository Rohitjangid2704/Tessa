import { api } from "@/lib/api/client";
import { unwrap } from "@/lib/api/unwrap";
import type { ExplorationCreate } from "@/lib/api/types";
import { useStartRun } from "@/features/runs/start-mutation";

function postExploration(body: ExplorationCreate, idempotencyKey: string) {
  return unwrap(
    api.POST("/api/v1/explorations", {
      params: { header: { "Idempotency-Key": idempotencyKey } },
      body,
    }),
  );
}

export function useStartExploration() {
  return useStartRun<ExplorationCreate>(postExploration);
}
