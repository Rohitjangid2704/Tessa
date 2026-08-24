import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { qk } from "@/lib/api/query-keys";

export const REDTEAM_SYNC_THROTTLE_MS = 800;

export function useRedteamLiveSync(runId: string, lastSeq: number, findingCount: number): void {
  const queryClient = useQueryClient();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (lastSeq === 0 || pending.current !== null) {
      return;
    }
    pending.current = setTimeout(() => {
      pending.current = null;
      void queryClient.invalidateQueries({ queryKey: qk.redteam.rounds(runId) });
      void queryClient.invalidateQueries({ queryKey: qk.attacks.list(runId) });
    }, REDTEAM_SYNC_THROTTLE_MS);
  }, [queryClient, runId, lastSeq]);

  useEffect(() => {
    if (findingCount > 0) {
      void queryClient.invalidateQueries({ queryKey: qk.findings.all() });
    }
  }, [queryClient, findingCount]);

  useEffect(
    () => () => {
      if (pending.current !== null) {
        clearTimeout(pending.current);
        pending.current = null;
      }
    },
    [],
  );
}
