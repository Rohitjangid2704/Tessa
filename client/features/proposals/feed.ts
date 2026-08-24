import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { KeyedTrailingThrottle } from "@/lib/keyed-throttle";
import { qk } from "@/lib/api/query-keys";
import { feedPath } from "@/lib/sse/feed-paths";
import type { EventStreamState } from "@/lib/sse/stream";
import { useEventStream } from "@/lib/sse/use-event-stream";

export const PROPOSAL_REFETCH_THROTTLE_MS = 500;

export async function invalidateProposalCaches(
  queryClient: QueryClient,
  targetId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: qk.proposals.current(targetId) }),
    queryClient.invalidateQueries({ queryKey: qk.coverage.all() }),
    queryClient.invalidateQueries({ queryKey: qk.catalogRoot() }),
  ]);
}

export function useProposalFeed(targetId: string): EventStreamState {
  const queryClient = useQueryClient();
  const [throttle] = useState(() => new KeyedTrailingThrottle(PROPOSAL_REFETCH_THROTTLE_MS));
  const helloSeen = useRef(false);

  useEffect(() => () => throttle.cancel(), [throttle]);

  return useEventStream(feedPath("coverage"), {
    query: { target_id: targetId },
    onEvent: (event) => {
      if (event.type === "stream.hello") {
        if (helloSeen.current) {
          throttle.schedule("proposal", () => {
            void invalidateProposalCaches(queryClient, targetId);
          });
        }
        helloSeen.current = true;
        return;
      }
      if (event.type === "proposal.updated" && event.payload.target_id === targetId) {
        throttle.schedule("proposal", () => {
          void invalidateProposalCaches(queryClient, targetId);
        });
      }
    },
  });
}
