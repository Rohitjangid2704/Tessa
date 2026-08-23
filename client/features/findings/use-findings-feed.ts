import { useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { StreamEventOf } from "@/features/streams/events";
import { qk } from "@/lib/api/query-keys";
import type { FindingPage } from "@/lib/api/types";
import { feedPath } from "@/lib/sse/feed-paths";
import type { EventStreamState } from "@/lib/sse/stream";
import { useEventStream } from "@/lib/sse/use-event-stream";
import { applyFindingFeedEvent } from "./apply-feed-event";
import type { FindingBoardFilters } from "./schemas";

export interface BufferedFinding {
  findingId: string;
  title: string;
}

export interface FindingsFeed {
  state: EventStreamState;
  buffered: readonly BufferedFinding[];
  showBuffered: () => void;
}

export interface FindingsFeedOptions {
  targetId: string;
  filters: FindingBoardFilters;
}

function isCached(queryClient: QueryClient, findingId: string): boolean {
  const lists = queryClient.getQueriesData<InfiniteData<FindingPage, string | null>>({
    queryKey: qk.findings.lists(),
  });
  return lists.some(
    ([, data]) =>
      data !== undefined &&
      data.pages.some((page) => page.items.some((item) => item.id === findingId)),
  );
}

function matchesFilters(
  payload: StreamEventOf<"finding.created">["payload"],
  filters: FindingBoardFilters,
): boolean {
  const severities = filters.severity ?? [];
  const classes = filters.class ?? [];
  return (
    (severities.length === 0 || severities.includes(payload.severity)) &&
    (classes.length === 0 || classes.includes(payload.class))
  );
}

export function useFindingsFeed({ targetId, filters }: FindingsFeedOptions): FindingsFeed {
  const queryClient = useQueryClient();
  const [buffered, setBuffered] = useState<readonly BufferedFinding[]>([]);

  const state = useEventStream(feedPath("findings"), {
    query: { target_id: targetId },
    onEvent: (event) => {
      if (event.type !== "finding.created") {
        applyFindingFeedEvent(queryClient, event);
        return;
      }
      const { payload } = event;
      const relevant = payload.is_new && matchesFilters(payload, filters);
      if (!relevant || isCached(queryClient, payload.finding_id)) {
        return;
      }
      setBuffered((previous) =>
        previous.some((entry) => entry.findingId === payload.finding_id)
          ? previous
          : [...previous, { findingId: payload.finding_id, title: payload.title }],
      );
    },
    onHello: (_event, context) => {
      if (context.reconnect) {
        void queryClient.invalidateQueries({ queryKey: qk.findings.all() });
      }
    },
  });

  function showBuffered(): void {
    setBuffered([]);
    void queryClient.invalidateQueries({ queryKey: qk.findings.lists() });
  }

  return { state, buffered, showBuffered };
}
