import { useQueryClient } from "@tanstack/react-query";
import type { KnownStreamEvent } from "@/features/streams/events";
import { useEventStream } from "@/lib/sse/use-event-stream";
import type { EventStreamState } from "@/lib/sse/stream";
import { applyRunFeedEvent } from "./apply-feed-event";
import type { RunListFilters } from "./queries";

export const RUNS_FEED_PATH = "/api/v1/feeds/runs";

export function runsFeedPath(filters: Pick<RunListFilters, "target_id" | "kind">): string {
  const params = new URLSearchParams();
  if (filters.target_id !== undefined) {
    params.set("target_id", filters.target_id);
  }
  for (const kind of filters.kind ?? []) {
    params.append("kind", kind);
  }
  const query = params.toString();
  return query === "" ? RUNS_FEED_PATH : `${RUNS_FEED_PATH}?${query}`;
}

export function useRunsFeed(
  filters: RunListFilters,
  onEvent?: (event: KnownStreamEvent) => void,
): EventStreamState {
  const queryClient = useQueryClient();
  return useEventStream(runsFeedPath(filters), {
    onEvent: (event) => {
      applyRunFeedEvent(queryClient, event);
      onEvent?.(event);
    },
  });
}
