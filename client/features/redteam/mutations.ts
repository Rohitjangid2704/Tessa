import { useStartRun } from "@/features/runs/start-mutation";
import { api } from "@/lib/api/client";
import type { RedTeamCreate } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

function postRedTeamRun(body: RedTeamCreate, idempotencyKey: string) {
  return unwrap(
    api.POST("/api/v1/redteam-runs", {
      params: { header: { "Idempotency-Key": idempotencyKey } },
      body,
    }),
  );
}

export function useStartRedTeam() {
  return useStartRun<RedTeamCreate>(postRedTeamRun);
}
