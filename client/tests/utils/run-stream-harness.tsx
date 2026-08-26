import type { ReactElement } from "react";
import type { KnownStreamEvent } from "@/features/streams/events";
import {
  RunStreamHandleContext,
  RunStreamStateContext,
  type RunStreamHandle,
  type RunStreamState,
} from "@/features/runs/use-run-stream";
import { RunEventStore } from "@/features/runs/run-event-store";
import { FrameBus } from "@/lib/ws/frame-bus";
import { makeRun, RUN_ID } from "./run-detail-fixtures";
import { renderWithProviders, type ProvidersOptions } from "./render";

export function makeStreamState(overrides: Partial<RunStreamState> = {}): RunStreamState {
  return {
    phase: "ready",
    error: null,
    retry: () => {},
    restart: () => {},
    run: makeRun(),
    status: "live",
    lastSeq: 0,
    attempt: 0,
    nextRetryInMs: null,
    nextRetryAt: null,
    message: null,
    closeCode: null,
    replayComplete: true,
    limits: null,
    isTerminal: false,
    isLive: true,
    ...overrides,
  };
}

export interface StreamHarnessOptions extends ProvidersOptions {
  state?: Partial<RunStreamState>;
  events?: readonly KnownStreamEvent[];
  send?: RunStreamHandle["send"];
}

export function createHarnessStore(events: readonly KnownStreamEvent[] = []): RunEventStore {
  const store = new RunEventStore(RUN_ID);
  const highest = events.reduce((seq, event) => Math.max(seq, event.seq ?? 0), 0);
  store.load({
    events: [...events],
    lowestSeq: events[0]?.seq ?? null,
    highestSeq: highest,
    headSeq: highest,
    hasMore: false,
    skipped: 0,
  });
  return store;
}

export function renderWithStream(
  ui: ReactElement,
  { state, events, send = () => true, ...providers }: StreamHarnessOptions = {},
) {
  const handle: RunStreamHandle = {
    runId: RUN_ID,
    events: createHarnessStore(events),
    frameBus: new FrameBus(),
    send,
  };
  const value = makeStreamState(state);
  return renderWithProviders(
    <RunStreamHandleContext.Provider value={handle}>
      <RunStreamStateContext.Provider value={value}>{ui}</RunStreamStateContext.Provider>
    </RunStreamHandleContext.Provider>,
    providers,
  );
}
