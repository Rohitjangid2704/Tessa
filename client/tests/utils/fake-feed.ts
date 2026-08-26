import { vi } from "vitest";
import type { KnownStreamEvent } from "@/features/streams/events";
import { EventStream, type EventStreamOptions } from "@/lib/sse/stream";
import type { WireEnvelope } from "./stream-fixtures";

const encoder = new TextEncoder();

export function sseFrame(type: string, wire: WireEnvelope, id?: string): string {
  const idLine = id === undefined ? "" : `id: ${id}\n`;
  return `${idLine}event: ${type}\ndata: ${JSON.stringify(wire)}\n\n`;
}

export class FeedConnection {
  closedByServer = false;
  aborted = false;

  constructor(
    readonly request: Request,
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
  ) {
    request.signal.addEventListener("abort", () => {
      this.aborted = true;
      try {
        controller.error(new DOMException("aborted", "AbortError"));
      } catch {
        return;
      }
    });
  }

  push(text: string): void {
    this.controller.enqueue(encoder.encode(text));
  }

  pushBytes(bytes: Uint8Array): void {
    this.controller.enqueue(bytes);
  }

  end(): void {
    this.closedByServer = true;
    this.controller.close();
  }

  breakWith(error: Error): void {
    this.controller.error(error);
  }

  get header(): (name: string) => string | null {
    return (name) => this.request.headers.get(name);
  }
}

export type FeedResponder = (request: Request, attempt: number) => Response | Error | undefined;

export function createFeedHarness(
  options: Partial<EventStreamOptions> & { respond?: FeedResponder } = {},
) {
  const connections: FeedConnection[] = [];
  const events: KnownStreamEvent[] = [];
  const hellos: Array<{ reconnect: boolean }> = [];
  let attempts = 0;
  const { respond, ...streamOptions } = options;

  const fetchMock = vi.fn(async (request: Request): Promise<Response> => {
    attempts += 1;
    const scripted = respond?.(request, attempts);
    if (scripted instanceof Error) {
      throw scripted;
    }
    if (scripted !== undefined) {
      return scripted;
    }
    let connection: FeedConnection | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        connection = new FeedConnection(request, controller);
        connections.push(connection);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });

  const stream = new EventStream({
    url: "http://api.test/api/v1/feeds/runs?kind=hello",
    fetch: fetchMock,
    random: () => 0.5,
    ...streamOptions,
  });
  stream.setListeners({
    onEvent: (event) => events.push(event),
    onHello: (_event, context) => hellos.push(context),
  });

  return {
    stream,
    connections,
    events,
    hellos,
    fetchMock,
    get latest(): FeedConnection {
      const connection = connections.at(-1);
      if (connection === undefined) {
        throw new Error("no connection has been opened yet");
      }
      return connection;
    },
  };
}

export type FeedHarness = ReturnType<typeof createFeedHarness>;
