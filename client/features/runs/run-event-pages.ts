import { parseStreamMessage, type KnownStreamEvent } from "@/features/streams/events";
import { api } from "@/lib/api/client";
import { unwrap } from "@/lib/api/unwrap";

export const RUN_EVENTS_TAIL_LIMIT = 200;

export interface RunEventsPage {
  events: KnownStreamEvent[];
  lowestSeq: number | null;
  highestSeq: number;
  headSeq: number;
  hasMore: boolean;
  skipped: number;
}

export interface FetchRunEventsPageOptions {
  beforeSeq?: number;
  limit?: number;
  signal?: AbortSignal;
}

export async function fetchRunEventsPage(
  runId: string,
  { beforeSeq, limit = RUN_EVENTS_TAIL_LIMIT, signal }: FetchRunEventsPageOptions = {},
): Promise<RunEventsPage> {
  const page = await unwrap(
    api.GET("/api/v1/runs/{run_id}/events", {
      params: {
        path: { run_id: runId },
        query: { order: "desc", limit, before_seq: beforeSeq },
      },
      signal,
    }),
  );

  const events: KnownStreamEvent[] = [];
  let skipped = 0;
  let lowestSeq: number | null = null;
  let highestSeq = 0;
  for (const item of page.items) {
    lowestSeq = lowestSeq === null ? item.seq : Math.min(lowestSeq, item.seq);
    highestSeq = Math.max(highestSeq, item.seq);
    const parsed = parseStreamMessage(item);
    if (parsed.kind === "known") {
      events.push(parsed.event);
    } else {
      skipped += 1;
    }
  }
  events.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));

  return {
    events,
    lowestSeq,
    highestSeq,
    headSeq: Math.max(page.head_seq, highestSeq),
    hasMore: page.has_more,
    skipped,
  };
}
