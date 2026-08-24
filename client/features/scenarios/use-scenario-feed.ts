import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { qk } from "@/lib/api/query-keys";
import { KeyedTrailingThrottle } from "@/lib/keyed-throttle";
import { feedPath } from "@/lib/sse/feed-paths";
import type { EventStreamState } from "@/lib/sse/stream";
import { useEventStream } from "@/lib/sse/use-event-stream";

export const SCENARIO_FEED_THROTTLE_MS = 1000;

const SCENARIOS_THROTTLE_KEY = "scenarios";

export function useScenarioFeed(targetId: string | null | undefined): EventStreamState {
  const queryClient = useQueryClient();
  const [throttle] = useState(() => new KeyedTrailingThrottle(SCENARIO_FEED_THROTTLE_MS));
  const active = typeof targetId === "string" && targetId !== "";

  useEffect(() => () => throttle.cancel(), [throttle]);

  return useEventStream(active ? feedPath("coverage") : null, {
    enabled: active,
    query: { target_id: targetId ?? null },
    onEvent: (event) => {
      if (event.type === "scenario.changed") {
        throttle.schedule(SCENARIOS_THROTTLE_KEY, () => {
          void queryClient.invalidateQueries({ queryKey: qk.scenarios.lists() });
        });
      }
    },
  });
}
