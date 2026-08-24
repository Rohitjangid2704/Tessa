import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { ResyncRequest, ResyncResult } from "@/lib/ws/socket";
import { parseStreamMessage, type KnownStreamEvent } from "./events";

export const RUN_EVENTS_PAGE_LIMIT = 200;

export interface LoadedRunEvents {
  events: KnownStreamEvent[];
  lastSeq: number;
  headSeq: number;
  skipped: number;
}

export interface FetchRunEventsOptions {
  afterSeq?: number;
  signal?: AbortSignal;
}

export async function fetchRunEvents(
  runId: string,
  { afterSeq = 0, signal }: FetchRunEventsOptions = {},
): Promise<LoadedRunEvents> {
  const events: KnownStreamEvent[] = [];
  let skipped = 0;
  let cursor = afterSeq;
  let headSeq = afterSeq;

  for (;;) {
    const page = await unwrap(
      api.GET("/api/v1/runs/{run_id}/events", {
        params: {
          path: { run_id: runId },
          query: { after_seq: cursor, limit: RUN_EVENTS_PAGE_LIMIT, order: "asc" },
        },
        signal,
      }),
    );
    headSeq = Math.max(headSeq, page.head_seq);
    for (const item of page.items) {
      const parsed = parseStreamMessage(item);
      if (parsed.kind === "known") {
        events.push(parsed.event);
      } else {
        skipped += 1;
      }
      cursor = Math.max(cursor, item.seq);
    }
    if (!page.has_more || page.items.length === 0) {
      break;
    }
  }

  return { events, lastSeq: cursor, headSeq: Math.max(headSeq, cursor), skipped };
}

export function runEventsQuery(runId: string) {
  return queryOptions({
    queryKey: qk.runs.events(runId),
    queryFn: ({ signal }) => fetchRunEvents(runId, { signal }),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

export function createRunEventsResync(runId: string) {
  return async function resync(request: ResyncRequest): Promise<ResyncResult> {
    const loaded = await fetchRunEvents(runId, {
      afterSeq: request.afterSeq,
      signal: request.signal,
    });
    for (const event of loaded.events) {
      request.apply(event);
    }
    return { headSeq: loaded.lastSeq };
  };
}
