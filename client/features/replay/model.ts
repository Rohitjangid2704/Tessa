import type { KnownStreamEvent } from "@/features/streams/events";
import type { ReplayProgressPayload } from "@/lib/api/types";

export interface ReplayProgress {
  payload: ReplayProgressPayload;
  seq: number;
}

export function latestReplayProgress(events: readonly KnownStreamEvent[]): ReplayProgress | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.type === "replay.progress") {
      return { payload: event.payload, seq: event.seq ?? 0 };
    }
  }
  return null;
}
