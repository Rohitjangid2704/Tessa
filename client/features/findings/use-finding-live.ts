import { useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/api/query-keys";
import { feedPath } from "@/lib/sse/feed-paths";
import type { EventStreamState } from "@/lib/sse/stream";
import { useEventStream } from "@/lib/sse/use-event-stream";
import { applyFindingFeedEvent } from "./apply-feed-event";

export interface UseFindingLiveOptions {
  targetId: string | null;
  enabled: boolean;
}

export function useFindingLive({ targetId, enabled }: UseFindingLiveOptions): EventStreamState {
  const queryClient = useQueryClient();
  const active = enabled && targetId !== null;

  return useEventStream(active ? feedPath("findings") : null, {
    enabled: active,
    query: { target_id: targetId },
    onEvent: (event) => applyFindingFeedEvent(queryClient, event),
    onHello: (_event, context) => {
      if (context.reconnect) {
        void queryClient.invalidateQueries({ queryKey: qk.findings.all() });
      }
    },
  });
}
