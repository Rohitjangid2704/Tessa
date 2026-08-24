"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  TILE_SUBSCRIBE_DEBOUNCE_MS,
  useFrameBus,
  useFrameBusTransport,
} from "@/lib/ws/frame-bus";
import type { ResyncRequest, ResyncResult } from "@/lib/ws/socket";
import { useRunSocket, type UseRunSocketOptions } from "@/lib/ws/use-run-socket";
import { applyRunEvent, reconcileRunWithEvents, refreshRunFromRest } from "./apply-run-event";
import { fetchRunEventsPage } from "./run-event-pages";
import { RunEventStore } from "./run-event-store";
import { isTerminalRunStatus } from "./run-status";
import { useRunBootstrap } from "./use-run-bootstrap";
import {
  RunStreamHandleContext,
  RunStreamStateContext,
  type RunStreamHandle,
  type RunStreamState,
} from "./use-run-stream";

export type RunStreamSocketOptions = Pick<
  UseRunSocketOptions,
  "webSocketFactory" | "silenceTimeoutMs" | "dependencies"
>;

export interface RunStreamProviderProps {
  runId: string;
  children: ReactNode;
  socketOptions?: RunStreamSocketOptions;
}

interface RunStreamBoundaryProps extends RunStreamProviderProps {
  restart: () => void;
}

export function RunStreamProvider({ runId, children, socketOptions }: RunStreamProviderProps) {
  const [generation, setGeneration] = useState(0);
  const restart = useCallback(() => setGeneration((current) => current + 1), []);
  return (
    <RunStreamBoundary
      key={`${runId}:${generation}`}
      runId={runId}
      socketOptions={socketOptions}
      restart={restart}
    >
      {children}
    </RunStreamBoundary>
  );
}

function RunStreamBoundary({ runId, children, socketOptions, restart }: RunStreamBoundaryProps) {
  const queryClient = useQueryClient();
  const [store] = useState(
    () =>
      new RunEventStore(runId, {
        fetchPage: (beforeSeq) => fetchRunEventsPage(runId, { beforeSeq }),
      }),
  );
  const frameBus = useFrameBus({ subscribeDebounceMs: TILE_SUBSCRIBE_DEBOUNCE_MS });
  const bootstrap = useRunBootstrap(runId, store);

  const loaded = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().loaded,
    () => false,
  );
  const finished = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().finished,
    () => false,
  );
  const gap = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().gap,
    () => null,
  );

  const resync = async (request: ResyncRequest): Promise<ResyncResult> => {
    const page = await fetchRunEventsPage(runId, { signal: request.signal });
    store.load(page);
    reconcileRunWithEvents(queryClient, runId, page.events);
    refreshRunFromRest(queryClient, runId);
    return { headSeq: page.highestSeq };
  };

  const socket = useRunSocket(loaded ? runId : null, {
    enabled: !finished,
    initialLastSeq: store.getLastSeq(),
    webSocketFactory: socketOptions?.webSocketFactory,
    silenceTimeoutMs: socketOptions?.silenceTimeoutMs,
    dependencies: { resync, ...socketOptions?.dependencies },
    onEvent: (event) => {
      if (event.type === "tile.frame") {
        frameBus.publish(event.payload);
        return;
      }
      applyRunEvent(queryClient, store, event);
    },
    onSkipped: (seq) => {
      store.skip(seq);
    },
    onMessageHandled: (sample) => frameBus.recordHandlerSample(sample.durationMs),
  });

  useFrameBusTransport(
    frameBus,
    socket.send,
    socket.status === "live" && socket.replayComplete,
    socket.limits?.max_tiles,
  );

  const { reconnect } = socket;
  useEffect(() => {
    if (gap === null) {
      return;
    }
    reconnect({ lastSeq: store.getLastSeq(), message: "An event was missed; resuming" });
    store.clearGap();
  }, [gap, reconnect, store]);

  useEffect(() => () => store.dispose(), [store]);

  const { send } = socket;
  const handle = useMemo<RunStreamHandle>(
    () => ({ runId, events: store, frameBus, send }),
    [runId, store, frameBus, send],
  );

  const { run } = bootstrap;
  const isTerminal = run !== undefined && isTerminalRunStatus(run.status);
  const state = useMemo<RunStreamState>(
    () => ({
      phase: bootstrap.phase,
      error: bootstrap.error,
      retry: bootstrap.retry,
      restart,
      run,
      status: socket.status,
      lastSeq: socket.lastSeq,
      attempt: socket.attempt,
      nextRetryInMs: socket.nextRetryInMs,
      nextRetryAt: socket.nextRetryAt,
      message: socket.message,
      closeCode: socket.closeCode,
      replayComplete: socket.replayComplete,
      limits: socket.limits,
      isTerminal,
      isLive: socket.status === "live" && !isTerminal,
    }),
    [
      bootstrap.phase,
      bootstrap.error,
      bootstrap.retry,
      restart,
      run,
      socket.status,
      socket.lastSeq,
      socket.attempt,
      socket.nextRetryInMs,
      socket.nextRetryAt,
      socket.message,
      socket.closeCode,
      socket.replayComplete,
      socket.limits,
      isTerminal,
    ],
  );

  return (
    <RunStreamHandleContext.Provider value={handle}>
      <RunStreamStateContext.Provider value={state}>{children}</RunStreamStateContext.Provider>
    </RunStreamHandleContext.Provider>
  );
}
