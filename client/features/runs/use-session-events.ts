import { useState, useSyncExternalStore } from "react";
import { createSessionEventsSource, type SessionEvents } from "./tile-sessions";
import { useRunStreamHandle } from "./use-run-stream";

export function useSessionEvents(): SessionEvents {
  const { events } = useRunStreamHandle();
  const [source] = useState(() => createSessionEventsSource(events));
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}
