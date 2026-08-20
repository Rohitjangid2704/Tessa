import { useCallback, useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import type { ClientMessage, KnownStreamEvent } from "@/features/streams/events";
import { createRunEventsResync } from "@/features/streams/run-events";
import { api } from "@/lib/api/client";
import { unwrap } from "@/lib/api/unwrap";
import { refreshToken } from "@/lib/auth/token-client";
import {
  RunSocket,
  createInitialRunSocketState,
  type MessageSample,
  type ReconnectRequest,
  type RunSocketOptions,
  type RunSocketState,
  type WebSocketFactory,
} from "./socket";

export type RunSocketDependencies = Partial<
  Pick<RunSocketOptions, "requestTicket" | "refreshToken" | "resync" | "random">
>;

export interface UseRunSocketOptions {
  enabled?: boolean;
  initialLastSeq?: number;
  onEvent?: (event: KnownStreamEvent) => void;
  onSkipped?: (seq: number) => void;
  onMessageHandled?: (sample: MessageSample) => void;
  webSocketFactory?: WebSocketFactory;
  silenceTimeoutMs?: number;
  dependencies?: RunSocketDependencies;
}

export interface UseRunSocketResult extends RunSocketState {
  send: (message: ClientMessage) => boolean;
  reconnect: (request: ReconnectRequest) => boolean;
}

interface SocketEntry {
  runId: string;
  socket: RunSocket;
}

const idleState = createInitialRunSocketState();

const subscribeToNothing = (): (() => void) => () => {};

const readIdleState = (): RunSocketState => idleState;

function requestRunTicket(runId: string, signal: AbortSignal) {
  return unwrap(api.POST("/api/v1/ws-tickets", { body: { run_id: runId }, signal }));
}

function createEntry(runId: string | null, options: UseRunSocketOptions): SocketEntry | null {
  if (runId === null) {
    return null;
  }
  const { dependencies = {} } = options;
  const socket = new RunSocket({
    runId,
    initialLastSeq: options.initialLastSeq,
    requestTicket: dependencies.requestTicket ?? requestRunTicket,
    refreshToken: dependencies.refreshToken ?? (() => refreshToken()),
    resync: dependencies.resync ?? createRunEventsResync(runId),
    random: dependencies.random,
    webSocketFactory: options.webSocketFactory,
    silenceTimeoutMs: options.silenceTimeoutMs,
    onMessageHandled: options.onMessageHandled,
  });
  return { runId, socket };
}

export function useRunSocket(
  runId: string | null,
  options: UseRunSocketOptions = {},
): UseRunSocketResult {
  const { enabled = true, onEvent, onSkipped } = options;
  const [stored, setStored] = useState(() => createEntry(runId, options));

  let entry = stored;
  if ((entry?.runId ?? null) !== runId) {
    entry = createEntry(runId, options);
    setStored(entry);
  }
  const socket = entry?.socket ?? null;

  const handleEvent = useEffectEvent((event: KnownStreamEvent) => {
    onEvent?.(event);
  });

  const handleSkipped = useEffectEvent((seq: number) => {
    onSkipped?.(seq);
  });

  useEffect(() => {
    if (socket === null || !enabled) {
      return;
    }
    socket.setListeners({
      onEvent: (event) => handleEvent(event),
      onSkipped: (seq) => handleSkipped(seq),
    });
    socket.connect();
    return () => socket.close();
  }, [socket, enabled]);

  const state = useSyncExternalStore(
    socket?.subscribe ?? subscribeToNothing,
    socket?.getState ?? readIdleState,
    socket?.getState ?? readIdleState,
  );

  const send = useCallback((message: ClientMessage) => socket?.send(message) ?? false, [socket]);

  const reconnect = useCallback(
    (request: ReconnectRequest) => socket?.reconnect(request) ?? false,
    [socket],
  );

  return { ...state, send, reconnect };
}
