import { useState, useSyncExternalStore } from "react";
import { createFrameThrottledSource } from "./frame-throttled-source";
import type { RunEventsSnapshot } from "./run-event-store";
import { useRunStreamHandle } from "./use-run-stream";

export function useRunEventsPerFrame(): RunEventsSnapshot {
  const { events } = useRunStreamHandle();
  const [source] = useState(() => createFrameThrottledSource(events));
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}
