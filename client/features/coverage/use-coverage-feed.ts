import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { invalidateProposalCaches } from "@/features/proposals/feed";
import { KeyedTrailingThrottle } from "@/lib/keyed-throttle";
import { qk } from "@/lib/api/query-keys";
import { feedPath } from "@/lib/sse/feed-paths";
import type { EventStreamState } from "@/lib/sse/stream";
import { useEventStream } from "@/lib/sse/use-event-stream";
import { COVERAGE_REFETCH_THROTTLE_MS } from "./schemas";

const COVERAGE_THROTTLE_KEY = "coverage";
const SCENARIOS_THROTTLE_KEY = "scenarios";

export type CellFlashes = ReadonlyMap<string, number>;

export interface CoverageActivity {
  flashes: CellFlashes;
  lastBatchSize: number;
  batches: number;
}

export interface CoverageFeed {
  stream: EventStreamState;
  activity: CoverageActivity;
}

const NO_ACTIVITY: CoverageActivity = { flashes: new Map(), lastBatchSize: 0, batches: 0 };

export function coverageFeedPath(): string {
  return feedPath("coverage");
}

export function bumpFlashes(previous: CellFlashes, cellIds: readonly string[]): CellFlashes {
  const next = new Map(previous);
  for (const cellId of cellIds) {
    next.set(cellId, (next.get(cellId) ?? 0) + 1);
  }
  return next;
}

export function useCoverageFeed(targetId: string | null): CoverageFeed {
  const queryClient = useQueryClient();
  const [activity, setActivity] = useState<CoverageActivity>(NO_ACTIVITY);
  const [throttle] = useState(() => new KeyedTrailingThrottle(COVERAGE_REFETCH_THROTTLE_MS));
  const helloSeen = useRef(false);

  useEffect(() => () => throttle.cancel(), [throttle]);

  const stream = useEventStream(targetId === null ? null : coverageFeedPath(), {
    enabled: targetId !== null,
    query: { target_id: targetId },
    onEvent: (event) => {
      switch (event.type) {
        case "stream.hello":
          if (helloSeen.current) {
            throttle.schedule(COVERAGE_THROTTLE_KEY, () => {
              void queryClient.invalidateQueries({ queryKey: qk.coverage.all() });
            });
          }
          helloSeen.current = true;
          return;
        case "coverage.updated":
          throttle.schedule(COVERAGE_THROTTLE_KEY, () => {
            void queryClient.invalidateQueries({ queryKey: qk.coverage.all() });
          });
          setActivity((previous) => ({
            flashes: bumpFlashes(previous.flashes, event.payload.cell_ids),
            lastBatchSize: event.payload.cell_ids.length,
            batches: previous.batches + 1,
          }));
          return;
        case "proposal.updated":
          throttle.schedule(COVERAGE_THROTTLE_KEY, () => {
            void invalidateProposalCaches(queryClient, event.payload.target_id);
          });
          return;
        case "scenario.changed":
          throttle.schedule(SCENARIOS_THROTTLE_KEY, () => {
            void queryClient.invalidateQueries({ queryKey: qk.scenarios.lists() });
          });
          return;
        case "generation.progress":
          if (event.run_id !== null) {
            queryClient.setQueryData(qk.generation.run(event.run_id), event.payload);
          }
          return;
        default:
          return;
      }
    },
  });

  return { stream, activity };
}
