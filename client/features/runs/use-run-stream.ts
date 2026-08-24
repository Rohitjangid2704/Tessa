import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { ClientMessage, StreamLimits } from "@/features/streams/events";
import type { Run } from "@/lib/api/types";
import type { FrameBus } from "@/lib/ws/frame-bus";
import type { RunSocketStatus } from "@/lib/ws/socket";
import type { RunBootstrapPhase } from "./use-run-bootstrap";
import type { RunEventFeed, RunEventsSnapshot } from "./run-event-store";

export interface RunStreamHandle {
  runId: string;
  events: RunEventFeed;
  frameBus: FrameBus;
  send: (message: ClientMessage) => boolean;
}

export interface RunStreamState {
  phase: RunBootstrapPhase;
  error: unknown;
  retry: () => void;
  restart: () => void;
  run: Run | undefined;
  status: RunSocketStatus;
  lastSeq: number;
  attempt: number;
  nextRetryInMs: number | null;
  nextRetryAt: number | null;
  message: string | null;
  closeCode: number | null;
  replayComplete: boolean;
  limits: StreamLimits | null;
  isTerminal: boolean;
  isLive: boolean;
}

export type RunStream = RunStreamHandle & RunStreamState;

export const RunStreamHandleContext = createContext<RunStreamHandle | null>(null);

export const RunStreamStateContext = createContext<RunStreamState | null>(null);

const MISSING_PROVIDER = "useRunStream must be used inside RunStreamProvider";

export function useRunStreamHandle(): RunStreamHandle {
  const handle = useContext(RunStreamHandleContext);
  if (handle === null) {
    throw new Error(MISSING_PROVIDER);
  }
  return handle;
}

export function useRunStreamState(): RunStreamState {
  const state = useContext(RunStreamStateContext);
  if (state === null) {
    throw new Error(MISSING_PROVIDER);
  }
  return state;
}

export function useRunStream(): RunStream {
  const handle = useRunStreamHandle();
  const state = useRunStreamState();
  return useMemo(() => ({ ...handle, ...state }), [handle, state]);
}

export function useRunEvents(): RunEventsSnapshot {
  const { events } = useRunStreamHandle();
  return useSyncExternalStore(events.subscribe, events.getSnapshot, events.getSnapshot);
}
