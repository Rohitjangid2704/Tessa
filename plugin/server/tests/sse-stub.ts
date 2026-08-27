import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Clock } from "../src/client";

export type StubRequest = {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export type StubHandler = (request: StubRequest, response: ServerResponse, count: number) => void;

export type Stub = {
  url: string;
  requests: StubRequest[];
  count: (path: string) => number;
  route: (key: string, handler: StubHandler) => void;
  close: () => Promise<void>;
};

export const TARGET = "11111111-1111-4111-8111-111111111111";
export const FINDING = "22222222-2222-4222-8222-222222222222";
export const RUN = "33333333-3333-4333-8333-333333333333";
export const ITEM = "44444444-4444-4444-8444-444444444444";
export const PROPOSAL = "55555555-5555-4555-8555-555555555555";

export function envelope(type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { type, run_id: null, seq: null, ts: "2026-10-09T10:00:00Z", payload, ...extra };
}

export function frame(type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify(envelope(type, payload, extra))}\n\n`;
}

export function hello(feed: string): string {
  return frame("stream.hello", { run_id: null, head_seq: null, resumed_from: null, heartbeat_seconds: 15, limits: null, feed });
}

export function startSse(response: ServerResponse, ...frames: string[]): void {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const text of frames) {
    response.write(text);
  }
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(""));
  });
}

export async function startStub(port = 0): Promise<Stub> {
  const requests: StubRequest[] = [];
  const handlers = new Map<string, StubHandler>();
  const counts = new Map<string, number>();
  const sockets = new Set<import("node:net").Socket>();
  const open = new Set<ServerResponse>();
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    const seen: StubRequest = {
      method: request.method ?? "GET",
      path: url.pathname,
      search: url.search,
      headers: request.headers,
      body: await readBody(request),
    };
    requests.push(seen);
    open.add(response);
    response.on("close", () => open.delete(response));
    const key = `${seen.method} ${seen.path}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const handler = handlers.get(key) ?? handlers.get(seen.path);
    if (handler === undefined) {
      json(response, 404, { error: { code: "not_found", message: "no stub", request_id: "r" } });
      return;
    }
    handler(seen, response, count);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${bound}`,
    requests,
    count: (path) => requests.filter((entry) => entry.path === path).length,
    route: (key, handler) => {
      handlers.set(key, handler);
    },
    close: async () => {
      for (const response of open) {
        response.destroy();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function until(condition: () => boolean | Promise<boolean>, timeoutMilliseconds = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached in time");
}

export type RecordingClock = Clock & { sleeps: number[] };

export function recordingClock(): RecordingClock {
  const sleeps: number[] = [];
  return {
    now: () => Date.now(),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    sleeps,
  };
}
