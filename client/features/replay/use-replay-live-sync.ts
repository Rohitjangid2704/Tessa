import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { qk } from "@/lib/api/query-keys";

export const REPLAY_SYNC_THROTTLE_MS = 800;

export function useReplayLiveSync(replayId: string | null, lastSeq: number): void {
  const queryClient = useQueryClient();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (replayId === null || lastSeq === 0 || pending.current !== null) {
      return;
    }
    pending.current = setTimeout(() => {
      pending.current = null;
      void queryClient.invalidateQueries({ queryKey: qk.replays.detail(replayId) });
      void queryClient.invalidateQueries({ queryKey: qk.replays.records(replayId) });
      void queryClient.invalidateQueries({ queryKey: qk.replays.lists() });
    }, REPLAY_SYNC_THROTTLE_MS);
  }, [queryClient, replayId, lastSeq]);

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
