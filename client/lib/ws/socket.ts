import {
  parseStreamText,
  persistenceOf,
  type ClientMessage,
  type KnownStreamEvent,
  type StreamLimits,
} from "@/features/streams/events";
import { isApiError } from "@/lib/api/errors";
import { SILENCE_TIMEOUT_MS, backoffDelayMs } from "@/lib/backoff";
import { createStore, type Store } from "@/lib/store";

const SOCKET_OPEN = 1;
const NORMAL_CLOSURE = 1000;
const CLIENT_CLOSE_REASON_LIMIT = 120;

export const CLOSE_CODES = {
  normal: 1000,
  badClientMessage: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  unknownRun: 4404,
  maxAge: 4408,
  slowConsumer: 4413,
  tooManyConnections: 4429,
} as const;

export type RunSocketStatus =
  "idle" | "connecting" | "live" | "reconnecting" | "resyncing" | "closed" | "failed";

export interface RunSocketState {
  status: RunSocketStatus;
  lastSeq: number;
  attempt: number;
  nextRetryInMs: number | null;
  nextRetryAt: number | null;
  closeCode: number | null;
  message: string | null;
  replayComplete: boolean;
  resumedFrom: number | null;
  limits: StreamLimits | null;
  unknownEventCount: number;
  invalidMessageCount: number;
  duplicateEventCount: number;
  gapCount: number;
}

export interface SocketTransport {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
}

export type WebSocketFactory = (url: string) => SocketTransport;

export interface WsTicketLike {
  ws_url: string;
}

export interface ResyncRequest {
  afterSeq: number;
  reason: "gap_too_large" | "retention";
  minSeq: number;
  signal: AbortSignal;
  apply: (event: KnownStreamEvent) => void;
}

export interface ResyncResult {
  headSeq: number;
}

export interface MessageSample {
  durationMs: number;
  bytes: number;
}

export interface RunSocketOptions {
  runId: string;
  initialLastSeq?: number;
  requestTicket: (runId: string, signal: AbortSignal) => Promise<WsTicketLike>;
  refreshToken: () => Promise<unknown>;
  resync?: (request: ResyncRequest) => Promise<ResyncResult>;
  webSocketFactory?: WebSocketFactory;
  random?: () => number;
  silenceTimeoutMs?: number;
  onMessageHandled?: (sample: MessageSample) => void;
}

export interface RunSocketListeners {
  onEvent?: (event: KnownStreamEvent) => void;
  onSkipped?: (seq: number) => void;
}

export interface ReconnectRequest {
  lastSeq: number;
  message: string;
}

export type CloseAction = "stop" | "retry" | "refresh_then_retry";

export interface CloseDecision {
  action: CloseAction;
  terminal: "closed" | "failed" | null;
  message: string | null;
}

export function decideOnClose(code: number): CloseDecision {
  switch (code) {
    case CLOSE_CODES.normal:
      return { action: "stop", terminal: "closed", message: null };
    case CLOSE_CODES.badClientMessage:
      return {
        action: "stop",
        terminal: "failed",
        message: "The server rejected a message from this client",
      };
    case CLOSE_CODES.unauthenticated:
      return {
        action: "refresh_then_retry",
        terminal: null,
        message: "Refreshing your session",
      };
    case CLOSE_CODES.forbidden:
      return {
        action: "stop",
        terminal: "failed",
        message: "You do not have access to this stream",
      };
    case CLOSE_CODES.unknownRun:
      return { action: "stop", terminal: "failed", message: "This run was not found" };
    case CLOSE_CODES.maxAge:
      return {
        action: "retry",
        terminal: null,
        message: "The stream reached its maximum age; resuming",
      };
    case CLOSE_CODES.slowConsumer:
      return {
        action: "retry",
        terminal: null,
        message: "The connection could not keep up; resuming",
      };
    case CLOSE_CODES.tooManyConnections:
      return {
        action: "retry",
        terminal: null,
        message: "Too many live streams are open; retrying",
      };
    default:
      return { action: "retry", terminal: null, message: "The connection was lost; retrying" };
  }
}

export function appendLastSeq(wsUrl: string, lastSeq: number): string {
  const url = new URL(wsUrl);
  if (lastSeq > 0) {
    url.searchParams.set("last_seq", String(lastSeq));
  } else {
    url.searchParams.delete("last_seq");
  }
  return url.toString();
}

const defaultWebSocketFactory: WebSocketFactory = (url) =>
  new WebSocket(url) as unknown as SocketTransport;

const noop = () => {};

function reportListenerError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

interface Connection {
  transport: SocketTransport;
  watchdog: ReturnType<typeof setTimeout> | null;
}

type TicketFailure = { fatal: true; message: string } | { fatal: false; retryAfterMs: number };

function classifyTicketFailure(error: unknown): TicketFailure {
  if (!isApiError(error)) {
    return { fatal: false, retryAfterMs: 0 };
  }
  if (error.status === 404) {
    return { fatal: true, message: "This run was not found" };
  }
  if (error.status === 401 || error.status === 403) {
    return { fatal: true, message: "You are not allowed to watch this run" };
  }
  if (error.status === 429) {
    return { fatal: false, retryAfterMs: (error.retryAfterSeconds ?? 0) * 1000 };
  }
  if (error.isClientError) {
    return { fatal: true, message: error.message };
  }
  return { fatal: false, retryAfterMs: 0 };
}

export function createInitialRunSocketState(lastSeq: number = 0): RunSocketState {
  return {
    status: "idle",
    lastSeq,
    attempt: 0,
    nextRetryInMs: null,
    nextRetryAt: null,
    closeCode: null,
    message: null,
    replayComplete: false,
    resumedFrom: null,
    limits: null,
    unknownEventCount: 0,
    invalidMessageCount: 0,
    duplicateEventCount: 0,
    gapCount: 0,
  };
}

export class RunSocket {
  readonly runId: string;
  private readonly options: RunSocketOptions;
  private readonly store: Store<RunSocketState>;
  private readonly factory: WebSocketFactory;
  private readonly random: () => number;
  private readonly silenceTimeoutMs: number;
  private listeners: RunSocketListeners = {};
  private running = false;
  private generation = 0;
  private connection: Connection | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: AbortController | null = null;
  private lastActivityAt = 0;
  private refreshedAfterUnauthenticated = false;

  constructor(options: RunSocketOptions) {
    this.options = options;
    this.runId = options.runId;
    this.store = createStore(createInitialRunSocketState(options.initialLastSeq ?? 0));
    this.factory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.random = options.random ?? Math.random;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS;
  }

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  readonly getState = (): RunSocketState => this.store.getState();

  setListeners(listeners: RunSocketListeners): void {
    this.listeners = listeners;
  }

  connect(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.generation += 1;
    this.refreshedAfterUnauthenticated = false;
    this.patch({
      status: "connecting",
      attempt: 0,
      nextRetryInMs: null,
      nextRetryAt: null,
      closeCode: null,
      message: null,
      replayComplete: false,
    });
    const generation = this.generation;
    queueMicrotask(() => {
      if (generation === this.generation && this.running) {
        void this.openAttempt(generation);
      }
    });
  }

  reconnect(request: ReconnectRequest): boolean {
    if (!this.running || this.store.getState().status === "resyncing") {
      return false;
    }
    this.abortPending();
    this.retire(this.connection, "reconnect requested");
    if (request.lastSeq < this.store.getState().lastSeq) {
      this.patch({ lastSeq: request.lastSeq });
    }
    this.scheduleRetry({ message: request.message });
    return true;
  }

  close(): void {
    if (!this.running && this.connection === null) {
      return;
    }
    this.running = false;
    this.generation += 1;
    this.clearRetryTimer();
    this.abortPending();
    this.retire(this.connection, "client closed");
    this.patch({
      status: "closed",
      nextRetryInMs: null,
      nextRetryAt: null,
      message: null,
    });
  }

  send(message: ClientMessage): boolean {
    const transport = this.connection?.transport;
    if (transport === undefined || transport.readyState !== SOCKET_OPEN) {
      return false;
    }
    transport.send(JSON.stringify(message));
    return true;
  }

  private patch(changes: Partial<RunSocketState>): void {
    this.store.update((previous) => ({ ...previous, ...changes }));
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private abortPending(): void {
    this.pending?.abort();
    this.pending = null;
  }

  private retire(connection: Connection | null, reason: string): void {
    if (connection === null) {
      return;
    }
    if (connection.watchdog !== null) {
      clearTimeout(connection.watchdog);
      connection.watchdog = null;
    }
    const { transport } = connection;
    transport.onopen = null;
    transport.onmessage = null;
    transport.onclose = null;
    transport.onerror = noop;
    if (this.connection === connection) {
      this.connection = null;
    }
    try {
      transport.close(NORMAL_CLOSURE, reason.slice(0, CLIENT_CLOSE_REASON_LIMIT));
    } catch {
      return;
    }
  }

  private scheduleRetry(options: {
    message: string | null;
    immediate?: boolean;
    minDelayMs?: number;
  }): void {
    if (!this.running) {
      return;
    }
    const attempt = this.store.getState().attempt + 1;
    const delay = options.immediate
      ? 0
      : Math.max(options.minDelayMs ?? 0, backoffDelayMs(attempt, this.random));
    const generation = this.generation;
    this.clearRetryTimer();
    this.patch({
      status: "reconnecting",
      attempt,
      nextRetryInMs: delay,
      nextRetryAt: Date.now() + delay,
      message: options.message,
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (generation !== this.generation) {
        return;
      }
      this.patch({ nextRetryInMs: null, nextRetryAt: null });
      void this.openAttempt(generation);
    }, delay);
  }

  private fail(message: string, closeCode: number | null = null): void {
    this.running = false;
    this.generation += 1;
    this.clearRetryTimer();
    this.abortPending();
    this.patch({
      status: "failed",
      message,
      closeCode,
      nextRetryInMs: null,
      nextRetryAt: null,
    });
  }

  private async openAttempt(generation: number): Promise<void> {
    const controller = new AbortController();
    this.pending = controller;
    let wsUrl: string;
    try {
      const ticket = await this.options.requestTicket(this.runId, controller.signal);
      wsUrl = ticket.ws_url;
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.pending = null;
      const failure = classifyTicketFailure(error);
      if (failure.fatal) {
        this.fail(failure.message);
        return;
      }
      this.scheduleRetry({
        message: "Could not get a stream ticket; retrying",
        minDelayMs: failure.retryAfterMs,
      });
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.pending = null;

    let transport: SocketTransport;
    try {
      transport = this.factory(appendLastSeq(wsUrl, this.store.getState().lastSeq));
    } catch {
      this.scheduleRetry({ message: "Could not open the connection; retrying" });
      return;
    }
    const connection: Connection = { transport, watchdog: null };
    this.connection = connection;
    this.lastActivityAt = Date.now();
    this.armWatchdog(connection, this.silenceTimeoutMs);

    transport.onmessage = (event) => this.handleMessage(connection, event.data);
    transport.onclose = (event) => this.handleClose(connection, event.code);
    transport.onerror = noop;
  }

  private armWatchdog(connection: Connection, delayMs: number): void {
    connection.watchdog = setTimeout(() => {
      connection.watchdog = null;
      if (this.connection !== connection) {
        return;
      }
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs >= this.silenceTimeoutMs) {
        this.retire(connection, "silence");
        this.scheduleRetry({ message: "The stream went silent; reconnecting" });
        return;
      }
      this.armWatchdog(connection, this.silenceTimeoutMs - idleMs);
    }, delayMs);
  }

  private handleClose(connection: Connection, code: number): void {
    if (this.connection !== connection) {
      return;
    }
    this.retire(connection, "closed");
    const decision = decideOnClose(code);
    this.patch({ closeCode: code });
    if (decision.action === "stop") {
      this.running = false;
      this.generation += 1;
      this.patch({ status: decision.terminal ?? "closed", message: decision.message });
      return;
    }
    if (decision.action === "refresh_then_retry") {
      this.refreshThenRetry();
      return;
    }
    this.scheduleRetry({ message: decision.message });
  }

  private refreshThenRetry(): void {
    if (this.refreshedAfterUnauthenticated) {
      this.fail("Your session has expired", CLOSE_CODES.unauthenticated);
      return;
    }
    this.refreshedAfterUnauthenticated = true;
    const generation = this.generation;
    this.patch({ status: "reconnecting", message: "Refreshing your session" });
    this.options.refreshToken().then(
      () => {
        if (generation === this.generation) {
          this.scheduleRetry({ message: "Reconnecting", immediate: true });
        }
      },
      () => {
        if (generation === this.generation) {
          this.fail("Your session has expired", CLOSE_CODES.unauthenticated);
        }
      },
    );
  }

  private handleMessage(connection: Connection, data: unknown): void {
    if (this.connection !== connection) {
      return;
    }
    const startedAt = this.options.onMessageHandled === undefined ? 0 : performance.now();
    this.lastActivityAt = Date.now();
    if (typeof data !== "string") {
      this.patch({ invalidMessageCount: this.store.getState().invalidMessageCount + 1 });
      return;
    }
    this.process(connection, data);
    if (this.options.onMessageHandled !== undefined) {
      this.options.onMessageHandled({
        durationMs: performance.now() - startedAt,
        bytes: data.length,
      });
    }
  }

  private process(connection: Connection, text: string): void {
    const parsed = parseStreamText(text);

    if (parsed.kind === "invalid") {
      this.bump("invalidMessageCount");
      this.skipSeq(connection, parsed.seq);
      return;
    }

    if (parsed.kind === "unknown") {
      this.bump("unknownEventCount");
      this.skipSeq(connection, parsed.seq);
      return;
    }

    const { event } = parsed;
    if (event.run_id !== null && event.run_id !== this.runId) {
      this.bump("invalidMessageCount");
      return;
    }
    if (event.seq !== null && persistenceOf(event.type) === "persisted") {
      if (this.admitSeq(connection, event.seq) !== "apply") {
        return;
      }
      this.patch({ lastSeq: event.seq });
    }
    this.react(connection, event);
    this.deliver(event);
  }

  private bump(
    counter: "unknownEventCount" | "invalidMessageCount" | "duplicateEventCount" | "gapCount",
  ): void {
    this.store.update((previous) => ({ ...previous, [counter]: previous[counter] + 1 }));
  }

  private skipSeq(connection: Connection, seq: number | null): void {
    if (seq !== null && this.admitSeq(connection, seq) === "apply") {
      this.patch({ lastSeq: seq });
      try {
        this.listeners.onSkipped?.(seq);
      } catch (error) {
        reportListenerError(error);
      }
    }
  }

  private admitSeq(connection: Connection, seq: number): "apply" | "duplicate" | "gap" {
    const { lastSeq } = this.store.getState();
    if (seq === lastSeq + 1) {
      return "apply";
    }
    if (seq <= lastSeq) {
      this.bump("duplicateEventCount");
      return "duplicate";
    }
    this.bump("gapCount");
    this.retire(connection, "sequence gap");
    this.scheduleRetry({ message: "An event was missed; resuming" });
    return "gap";
  }

  private react(connection: Connection, event: KnownStreamEvent): void {
    switch (event.type) {
      case "stream.hello":
        this.refreshedAfterUnauthenticated = false;
        this.patch({
          status: "live",
          message: null,
          closeCode: null,
          limits: event.payload.limits,
          resumedFrom: event.payload.resumed_from,
        });
        return;
      case "stream.replay_end":
        this.patch({ replayComplete: true, attempt: 0 });
        return;
      case "stream.resync_required":
        this.startResync(connection, event.payload.reason, event.payload.min_seq);
        return;
      case "stream.closing":
        this.patch({ message: `The server is closing the stream (${event.payload.reason})` });
        return;
      case "stream.error":
        this.patch({ message: event.payload.message });
        return;
      default:
        return;
    }
  }

  private deliver(event: KnownStreamEvent): void {
    try {
      this.listeners.onEvent?.(event);
    } catch (error) {
      reportListenerError(error);
    }
  }

  private startResync(
    connection: Connection,
    reason: "gap_too_large" | "retention",
    minSeq: number,
  ): void {
    this.retire(connection, "resync");
    const { resync } = this.options;
    if (resync === undefined) {
      this.fail("The server cannot replay this run; reload to resync");
      return;
    }
    const generation = this.generation;
    const controller = new AbortController();
    this.pending = controller;
    this.patch({ status: "resyncing", message: "Reloading missed events", replayComplete: false });

    const apply = (event: KnownStreamEvent) => {
      if (generation !== this.generation) {
        return;
      }
      if (event.seq !== null) {
        if (event.seq <= this.store.getState().lastSeq) {
          return;
        }
        this.patch({ lastSeq: event.seq });
      }
      this.deliver(event);
    };

    resync({
      afterSeq: this.store.getState().lastSeq,
      reason,
      minSeq,
      signal: controller.signal,
      apply,
    }).then(
      (result) => {
        if (generation !== this.generation) {
          return;
        }
        this.pending = null;
        const { lastSeq } = this.store.getState();
        this.patch({ lastSeq: Math.max(lastSeq, result.headSeq) });
        this.scheduleRetry({ message: "Reconnecting after resync", immediate: true });
      },
      () => {
        if (generation !== this.generation) {
          return;
        }
        this.pending = null;
        this.scheduleRetry({ message: "Could not reload missed events; retrying" });
      },
    );
  }
}
