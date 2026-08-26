import WebSocket from "ws";
import {
  startMockServer,
  type MockServerOptions,
  type RunningMockServer,
} from "@/mocks/server/http";
import type { HelloRunCreate, RunHandle, WsTicket } from "@/mocks/types";
import { bearer } from "./tokens";

export const MOCK_API_ORIGIN = "http://localhost:8000";
export const MOCK_APP_ORIGIN = "http://localhost:3000";

export function startMockApi(options: MockServerOptions = {}): Promise<RunningMockServer> {
  return startMockServer({ port: 0, ...options });
}

export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export async function createHelloRun(
  baseUrl: string,
  token: string,
  body: Partial<HelloRunCreate> = {},
  idempotencyKey: string = crypto.randomUUID(),
): Promise<RunHandle> {
  const response = await postJson(baseUrl, "/api/v1/system/hello-runs", body, {
    ...bearer(token),
    "Idempotency-Key": idempotencyKey,
  });
  if (response.status !== 202) {
    throw new Error(`hello run request failed with ${response.status}`);
  }
  return (await response.json()) as RunHandle;
}

export async function requestWsTicket(
  baseUrl: string,
  token: string,
  runId: string,
): Promise<WsTicket> {
  const response = await postJson(baseUrl, "/api/v1/ws-tickets", { run_id: runId }, bearer(token));
  if (response.status !== 200) {
    throw new Error(`ws ticket request failed with ${response.status}`);
  }
  return (await response.json()) as WsTicket;
}

export interface ReceivedFrame {
  type: string;
  run_id: string | null;
  seq: number | null;
  ts: string;
  payload: Record<string, unknown>;
}

export interface SocketClose {
  code: number;
  reason: string;
}

const DEFAULT_WAIT_MS = 5000;
const POLL_INTERVAL_MS = 10;

export class SocketProbe {
  readonly frames: ReceivedFrame[] = [];
  closed: SocketClose | null = null;
  private readonly socket: WebSocket;

  constructor(url: string, origin?: string) {
    this.socket = new WebSocket(url, origin === undefined ? undefined : { origin });
    this.socket.on("message", (data) => {
      this.frames.push(JSON.parse(data.toString()) as ReceivedFrame);
    });
    this.socket.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
    this.socket.on("error", () => {});
  }

  get types(): string[] {
    return this.frames.map((frame) => frame.type);
  }

  get persisted(): ReceivedFrame[] {
    return this.frames.filter((frame) => frame.seq !== null);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  close(code = 1000): void {
    this.socket.close(code);
  }

  async waitUntil(condition: () => boolean, timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting; frames so far: ${this.types.join(", ")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  waitForType(type: string, timeoutMs?: number): Promise<void> {
    return this.waitUntil(() => this.types.includes(type), timeoutMs);
  }

  waitForClose(timeoutMs?: number): Promise<SocketClose> {
    return this.waitUntil(() => this.closed !== null, timeoutMs).then(
      () => this.closed as SocketClose,
    );
  }
}

export function openRunSocket(url: string, origin?: string): SocketProbe {
  return new SocketProbe(url, origin);
}
