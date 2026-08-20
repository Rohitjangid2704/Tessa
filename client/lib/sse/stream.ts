import { createParser, type EventSourceMessage } from "eventsource-parser";
import { parseStreamText, type KnownStreamEvent } from "@/features/streams/events";
import { ApiError } from "@/lib/api/errors";
import { SILENCE_TIMEOUT_MS, backoffDelayMs } from "@/lib/backoff";
import { createStore, type Store } from "@/lib/store";

export type EventStreamStatus =
  "idle" | "connecting" | "live" | "reconnecting" | "closed" | "failed";

export interface EventStreamState {
  status: EventStreamStatus;
  attempt: number;
  nextRetryInMs: number | null;
  nextRetryAt: number | null;
  message: string | null;
  lastEventId: string | null;
  helloCount: number;
  unknownEventCount: number;
  invalidMessageCount: number;
}

export type EventStreamFetch = (request: Request) => Promise<Response>;

export interface EventStreamOptions {
  url: string;
  fetch: EventStreamFetch;
  random?: () => number;
  silenceTimeoutMs?: number;
  maxBufferSize?: number;
}

export interface HelloContext {
  reconnect: boolean;
}

export interface EventStreamListeners {
  onEvent?: (event: KnownStreamEvent) => void;
  onHello?: (event: KnownStreamEvent, context: HelloContext) => void;
}

export type FeedQuery = Record<string, string | number | boolean | null | undefined>;

export function buildFeedUrl(path: string, baseUrl: string, query: FeedQuery = {}): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);
const DEFAULT_MAX_BUFFER_CHARACTERS = 4 * 1024 * 1024;

export function createInitialEventStreamState(): EventStreamState {
  return {
    status: "idle",
    attempt: 0,
    nextRetryInMs: null,
    nextRetryAt: null,
    message: null,
    lastEventId: null,
    helloCount: 0,
    unknownEventCount: 0,
    invalidMessageCount: 0,
  };
}

function reportListenerError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

interface Connection {
  controller: AbortController;
  watchdog: ReturnType<typeof setTimeout> | null;
  silent: boolean;
}

export class EventStream {
  private readonly options: EventStreamOptions;
  private readonly store: Store<EventStreamState> = createStore(createInitialEventStreamState());
  private readonly random: () => number;
  private readonly silenceTimeoutMs: number;
  private listeners: EventStreamListeners = {};
  private running = false;
  private generation = 0;
  private connection: Connection | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityAt = 0;

  constructor(options: EventStreamOptions) {
    this.options = options;
    this.random = options.random ?? Math.random;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS;
  }

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  readonly getState = (): EventStreamState => this.store.getState();

  get url(): string {
    return this.options.url;
  }

  setListeners(listeners: EventStreamListeners): void {
    this.listeners = listeners;
  }

  connect(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.generation += 1;
    this.patch({
      status: "connecting",
      attempt: 0,
      nextRetryInMs: null,
      nextRetryAt: null,
      message: null,
    });
    void this.openAttempt(this.generation);
  }

  close(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.generation += 1;
    this.clearRetryTimer();
    this.retire(this.connection);
    this.patch({ status: "closed", nextRetryInMs: null, nextRetryAt: null, message: null });
  }

  private patch(changes: Partial<EventStreamState>): void {
    this.store.update((previous) => ({ ...previous, ...changes }));
  }

  private bump(counter: "unknownEventCount" | "invalidMessageCount" | "helloCount"): void {
    this.store.update((previous) => ({ ...previous, [counter]: previous[counter] + 1 }));
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private retire(connection: Connection | null): void {
    if (connection === null) {
      return;
    }
    if (connection.watchdog !== null) {
      clearTimeout(connection.watchdog);
      connection.watchdog = null;
    }
    if (this.connection === connection) {
      this.connection = null;
    }
    connection.controller.abort();
  }

  private scheduleRetry(options: { message: string | null; minDelayMs?: number }): void {
    if (!this.running) {
      return;
    }
    const attempt = this.store.getState().attempt + 1;
    const delay = Math.max(options.minDelayMs ?? 0, backoffDelayMs(attempt, this.random));
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

  private fail(message: string): void {
    this.running = false;
    this.generation += 1;
    this.clearRetryTimer();
    this.retire(this.connection);
    this.patch({ status: "failed", message, nextRetryInMs: null, nextRetryAt: null });
  }

  private buildRequest(signal: AbortSignal): Request {
    const headers = new Headers({ Accept: "text/event-stream" });
    const { lastEventId } = this.store.getState();
    if (lastEventId !== null) {
      headers.set("Last-Event-ID", lastEventId);
    }
    return new Request(this.options.url, { method: "GET", headers, signal });
  }

  private async openAttempt(generation: number): Promise<void> {
    const connection: Connection = {
      controller: new AbortController(),
      watchdog: null,
      silent: false,
    };
    this.connection = connection;
    this.touch();
    this.armWatchdog(connection, this.silenceTimeoutMs);

    let response: Response;
    try {
      response = await this.options.fetch(this.buildRequest(connection.controller.signal));
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.retire(connection);
      this.scheduleRetry({
        message:
          error instanceof ApiError && error.isNetworkError
            ? "Cannot reach the API; retrying"
            : "Could not open the stream; retrying",
      });
      return;
    }
    if (generation !== this.generation) {
      void response.body?.cancel().catch(() => undefined);
      return;
    }

    if (!response.ok) {
      await this.handleFailedResponse(connection, response, generation);
      return;
    }
    if (response.body === null) {
      this.retire(connection);
      this.scheduleRetry({ message: "The stream had no body; retrying" });
      return;
    }
    await this.read(connection, response.body, generation);
  }

  private async handleFailedResponse(
    connection: Connection,
    response: Response,
    generation: number,
  ): Promise<void> {
    const body: unknown = await response.json().catch(() => null);
    if (generation !== this.generation) {
      return;
    }
    const error = ApiError.fromResponse(response, body);
    this.retire(connection);
    if (error.isClientError && !RETRYABLE_CLIENT_STATUSES.has(error.status)) {
      this.fail(error.message);
      return;
    }
    this.scheduleRetry({
      message: "The server is not accepting the stream; retrying",
      minDelayMs: (error.retryAfterSeconds ?? 0) * 1000,
    });
  }

  private async read(
    connection: Connection,
    body: ReadableStream<Uint8Array>,
    generation: number,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = createParser({
      maxBufferSize: this.options.maxBufferSize ?? DEFAULT_MAX_BUFFER_CHARACTERS,
      onId: (id) => this.patch({ lastEventId: id === "" ? null : id }),
      onComment: () => this.touch(),
      onEvent: (message) => this.handleMessage(message),
      onError: () => this.bump("invalidMessageCount"),
    });

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (generation !== this.generation) {
          return;
        }
        if (done) {
          break;
        }
        this.touch();
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } catch {
      if (generation !== this.generation) {
        return;
      }
      const wasSilent = connection.silent;
      this.retire(connection);
      this.scheduleRetry({
        message: wasSilent
          ? "The stream went silent; reconnecting"
          : "The stream broke; reconnecting",
      });
      return;
    }

    if (generation !== this.generation) {
      return;
    }
    this.retire(connection);
    this.scheduleRetry({ message: "The stream ended; reconnecting" });
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  private armWatchdog(connection: Connection, delayMs: number): void {
    connection.watchdog = setTimeout(() => {
      connection.watchdog = null;
      if (this.connection !== connection) {
        return;
      }
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs >= this.silenceTimeoutMs) {
        connection.silent = true;
        connection.controller.abort();
        return;
      }
      this.armWatchdog(connection, this.silenceTimeoutMs - idleMs);
    }, delayMs);
  }

  private handleMessage(message: EventSourceMessage): void {
    this.touch();
    if (message.data === "") {
      return;
    }
    const parsed = parseStreamText(message.data);
    if (parsed.kind === "invalid") {
      this.bump("invalidMessageCount");
      return;
    }
    if (parsed.kind === "unknown") {
      this.bump("unknownEventCount");
      return;
    }
    const { event } = parsed;
    if (event.type === "stream.hello") {
      const reconnect = this.store.getState().helloCount > 0;
      this.bump("helloCount");
      this.patch({ status: "live", attempt: 0, message: null });
      this.deliver(() => this.listeners.onHello?.(event, { reconnect }));
    }
    this.deliver(() => this.listeners.onEvent?.(event));
  }

  private deliver(call: () => void): void {
    try {
      call();
    } catch (error) {
      reportListenerError(error);
    }
  }
}
