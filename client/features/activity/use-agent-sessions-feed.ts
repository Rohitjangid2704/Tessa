import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { KeyedTrailingThrottle } from "@/lib/keyed-throttle";
import { qk } from "@/lib/api/query-keys";
import { feedPath } from "@/lib/sse/feed-paths";
import type { EventStreamState } from "@/lib/sse/stream";
import { useEventStream } from "@/lib/sse/use-event-stream";
import { HIDDEN_PAGE_GRACE_MS, usePageActivity } from "@/lib/use-page-activity";

export const AGENT_SESSIONS_THROTTLE_MS = 500;

const THROTTLE_KEY = "agent-sessions";

export function useAgentSessionsFeed(targetId: string): EventStreamState {
  const queryClient = useQueryClient();
  const active = usePageActivity(HIDDEN_PAGE_GRACE_MS);
  const [throttle] = useState(() => new KeyedTrailingThrottle(AGENT_SESSIONS_THROTTLE_MS));

  useEffect(() => () => throttle.cancel(), [throttle]);

  function refresh(): void {
    throttle.schedule(THROTTLE_KEY, () => {
      void queryClient.invalidateQueries({ queryKey: qk.agentSessions.all() });
    });
  }

  return useEventStream(feedPath("home"), {
    enabled: active,
    query: { target_id: targetId },
    onEvent: (event) => {
      if (event.type === "agent_session.changed") {
        refresh();
      }
    },
    onHello: (_event, context) => {
      if (context.reconnect) {
        refresh();
      }
    },
  });
}
