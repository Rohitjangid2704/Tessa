import { vi } from "vitest";
import type { KnownStreamEvent } from "@/features/streams/events";
import {
  RunSocket,
  type ResyncResult,
  type RunSocketOptions,
  type SocketTransport,
} from "@/lib/ws/socket";
import { FIXTURE_RUN_ID, type WireEnvelope } from "./stream-fixtures";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export class FakeTransport implements SocketTransport {
  readyState = CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closedByClient: { code: number | undefined; reason: string | undefined } | null = null;

  constructor(readonly url: string) {}

  get sentMessages(): unknown[] {
    return this.sent.map((text) => JSON.parse(text) as unknown);
  }

  open(): void {
    this.readyState = OPEN;
    this.onopen?.({});
  }

  receive(message: WireEnvelope | string | ArrayBuffer): void {
    const data =
      typeof message === "string" || message instanceof ArrayBuffer
        ? message
        : JSON.stringify(message);
    this.onmessage?.({ data });
  }

  receiveAll(messages: ReadonlyArray<WireEnvelope>): void {
    for (const message of messages) {
      this.receive(message);
    }
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = CLOSED;
    this.onclose?.({ code, reason });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedByClient = { code, reason };
    this.readyState = CLOSED;
  }

  get ticket(): string | null {
    return new URL(this.url).searchParams.get("ticket");
  }

  get lastSeqParam(): string | null {
    return new URL(this.url).searchParams.get("last_seq");
  }
}

export type SocketHarnessOptions = Partial<RunSocketOptions>;

export function createSocketHarness(
  options: SocketHarnessOptions = {},
  { withoutResync = false }: { withoutResync?: boolean } = {},
) {
  const transports: FakeTransport[] = [];
  const events: KnownStreamEvent[] = [];
  let ticketCounter = 0;

  const requestTicket = vi.fn(
    options.requestTicket ??
      (async (runId: string) => {
        ticketCounter += 1;
        return { ws_url: `ws://mock.test/ws/v1/runs/${runId}?ticket=ticket-${ticketCounter}` };
      }),
  );
  const refreshToken = vi.fn(options.refreshToken ?? (async () => "fresh-token"));
  const resync = vi.fn(options.resync ?? (async (): Promise<ResyncResult> => ({ headSeq: 0 })));

  const socket = new RunSocket({
    runId: FIXTURE_RUN_ID,
    random: () => 0.5,
    webSocketFactory: (url) => {
      const transport = new FakeTransport(url);
      transports.push(transport);
      return transport;
    },
    ...options,
    requestTicket,
    refreshToken,
    resync: withoutResync ? undefined : resync,
  });
  socket.setListeners({ onEvent: (event) => events.push(event) });

  return {
    socket,
    transports,
    events,
    requestTicket,
    refreshToken,
    resync,
    get latest(): FakeTransport {
      const transport = transports.at(-1);
      if (transport === undefined) {
        throw new Error("no transport has been opened yet");
      }
      return transport;
    },
    get eventSeqs(): Array<number | null> {
      return events.map((event) => event.seq);
    },
    get eventTypes(): string[] {
      return events.map((event) => event.type);
    },
  };
}

export type SocketHarness = ReturnType<typeof createSocketHarness>;
