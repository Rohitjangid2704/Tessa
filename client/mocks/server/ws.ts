import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { jwtVerify } from "jose";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { WS_RUN_PATH_PREFIX } from "../config";
import { secretKey } from "../factories/keys";
import type { MockState, RunRecord } from "../state";
import { FrameStreamer, getFramePool } from "./frames";
import type {
  EphemeralEventType,
  EventEnvelope,
  PayloadOf,
  RunEvent,
  StreamLimits,
} from "../types";

export const CLOSE_CODES = {
  normal: 1000,
  goingAway: 1001,
  badClientMessage: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  unknownRun: 4404,
  maxAge: 4408,
  slowConsumer: 4413,
  tooManyConnections: 4429,
} as const;

export const STREAM_LIMITS: StreamLimits = {
  max_tiles: 12,
  grid: { max_fps: 4, quality: 60, max_width: 640 },
  focus: { max_fps: 10, quality: 75, max_width: 1280 },
};

const CLIENT_MESSAGE_TYPES = ["tile.subscribe", "tile.ack"];
const MILLISECONDS_PER_SECOND = 1000;

export interface RunConnection {
  socket: WebSocket;
  runId: string;
  userId: string;
  send: (envelope: EventEnvelope) => void;
}

export interface ClientMessage {
  type: string;
  payload: Record<string, unknown>;
}

export type ClientMessageListener = (connection: RunConnection, message: ClientMessage) => void;

interface TicketClaims {
  userId: string;
  runId: string;
  ticketId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClientMessage(raw: RawData, isBinary: boolean): ClientMessage | null {
  if (isBinary) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw.toString());
    if (
      isRecord(parsed) &&
      typeof parsed.type === "string" &&
      CLIENT_MESSAGE_TYPES.includes(parsed.type) &&
      isRecord(parsed.payload)
    ) {
      return { type: parsed.type, payload: parsed.payload };
    }
  } catch {
    return null;
  }
  return null;
}

function parseLastSeq(raw: string | null): number | null | undefined {
  if (raw === null) {
    return null;
  }
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;
}

export class RunSocketHub {
  private readonly state: MockState;
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly openByUser = new Map<string, number>();
  private readonly messageListeners = new Set<ClientMessageListener>();
  readonly connections = new Set<RunConnection>();

  constructor(state: MockState) {
    this.state = state;
  }

  attach(server: Server): void {
    server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
  }

  onClientMessage(listener: ClientMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  closeAll(code: number = CLOSE_CODES.goingAway): void {
    for (const connection of this.connections) {
      connection.socket.close(code, "server shutting down");
    }
    for (const socket of this.sockets.clients) {
      socket.terminate();
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://mock.invalid");
    if (!url.pathname.startsWith(WS_RUN_PATH_PREFIX)) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.sockets.handleUpgrade(request, socket, head, (accepted) => {
      void this.serve(accepted, request, url);
    });
  }

  private async verifyTicket(ticket: string | null): Promise<TicketClaims | null> {
    if (ticket === null || ticket === "") {
      return null;
    }
    try {
      const { payload } = await jwtVerify(ticket, secretKey(this.state.config.wsTicketSigningKey), {
        algorithms: ["HS256"],
        requiredClaims: ["exp", "sub", "run_id", "jti"],
      });
      if (
        payload.typ !== "ws-ticket" ||
        typeof payload.sub !== "string" ||
        typeof payload.run_id !== "string" ||
        typeof payload.jti !== "string"
      ) {
        return null;
      }
      return { userId: payload.sub, runId: payload.run_id, ticketId: payload.jti };
    } catch {
      return null;
    }
  }

  private async serve(socket: WebSocket, request: IncomingMessage, url: URL): Promise<void> {
    const { state } = this;
    const pathRunId = url.pathname.slice(WS_RUN_PATH_PREFIX.length);

    const origin = request.headers.origin;
    if (origin !== undefined && !state.config.corsOrigins.includes(origin)) {
      socket.close(CLOSE_CODES.forbidden, "origin not allowed");
      return;
    }

    const claims = await this.verifyTicket(url.searchParams.get("ticket"));
    if (claims === null || state.usedTicketIds.has(claims.ticketId)) {
      socket.close(CLOSE_CODES.unauthenticated, "invalid or used ticket");
      return;
    }
    state.usedTicketIds.add(claims.ticketId);

    if (claims.runId !== pathRunId) {
      socket.close(CLOSE_CODES.forbidden, "ticket belongs to another run");
      return;
    }
    const run = state.findRun(pathRunId);
    if (run === undefined) {
      socket.close(CLOSE_CODES.unknownRun, "unknown run");
      return;
    }
    const lastSeq = parseLastSeq(url.searchParams.get("last_seq"));
    if (lastSeq === undefined) {
      socket.close(CLOSE_CODES.badClientMessage, "last_seq must be a non-negative integer");
      return;
    }
    const openForUser = this.openByUser.get(claims.userId) ?? 0;
    if (openForUser >= state.config.maxConnectionsPerUser) {
      socket.close(CLOSE_CODES.tooManyConnections, "too many connections");
      return;
    }

    this.run(socket, run, claims.userId, lastSeq);
  }

  private run(socket: WebSocket, run: RunRecord, userId: string, lastSeq: number | null): void {
    const { state } = this;
    const connection: RunConnection = {
      socket,
      runId: run.id,
      userId,
      send: (envelope) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(envelope));
        }
      },
    };
    this.connections.add(connection);
    this.openByUser.set(userId, (this.openByUser.get(userId) ?? 0) + 1);
    state.connections.opened += 1;
    state.connections.open += 1;

    const sendEphemeral = <Type extends EphemeralEventType>(
      type: Type,
      payload: PayloadOf<Type>,
    ) => {
      connection.send({ type, run_id: run.id, seq: null, ts: new Date().toISOString(), payload });
    };
    const sendPersisted = (event: RunEvent) => {
      connection.send({ ...event });
    };
    const closeWith = (
      code: number,
      reason: string,
      closingReason?: PayloadOf<"stream.closing">["reason"],
    ) => {
      if (closingReason !== undefined) {
        sendEphemeral("stream.closing", { reason: closingReason });
      }
      socket.close(code, reason);
    };

    const headSeq = run.events.length;
    const heartbeatSeconds = Math.max(
      1,
      Math.round(state.config.heartbeatIntervalMs / MILLISECONDS_PER_SECOND),
    );
    sendEphemeral("stream.hello", {
      run_id: run.id,
      head_seq: headSeq,
      resumed_from: lastSeq,
      heartbeat_seconds: heartbeatSeconds,
      limits: STREAM_LIMITS,
      feed: null,
    });

    const backlog = run.events.filter((event) => event.seq > (lastSeq ?? 0));
    if (backlog.length > state.config.replayMaxEvents) {
      sendEphemeral("stream.resync_required", {
        reason: "gap_too_large",
        min_seq: headSeq - state.config.replayMaxEvents + 1,
      });
      this.release(connection, userId);
      socket.close(CLOSE_CODES.normal, "resync required");
      return;
    }
    for (const event of backlog) {
      sendPersisted(event);
    }
    sendEphemeral("stream.replay_end", { through_seq: headSeq });

    const unsubscribe = state.subscribe(run.id, (event) => {
      if (socket.readyState !== socket.OPEN) {
        return;
      }
      if (state.faults.consume("ws_close_4413")) {
        closeWith(CLOSE_CODES.slowConsumer, "slow consumer", "slow_consumer");
        return;
      }
      if (state.faults.consume("ws_gap")) {
        sendPersisted({ ...event, seq: event.seq + 1 });
        return;
      }
      sendPersisted(event);
    });
    const heartbeat = setInterval(
      () => sendEphemeral("stream.heartbeat", {}),
      state.config.heartbeatIntervalMs,
    );
    const maxAge = setTimeout(
      () => closeWith(CLOSE_CODES.maxAge, "max age", "max_age"),
      state.config.streamMaxAgeMs,
    );

    let streamer: FrameStreamer | null = null;
    if (run.frameSessions !== undefined) {
      const poolSize = run.framePoolSize ?? run.frameSessions.length;
      void getFramePool(poolSize).then((pool) => {
        if (socket.readyState !== socket.OPEN || streamer !== null) {
          return;
        }
        streamer = new FrameStreamer({
          runId: run.id,
          sessions: (run.frameSessions ?? []).filter((session) => session.active !== false),
          pool,
          limits: STREAM_LIMITS,
          sink: { send: connection.send, bufferedAmount: () => socket.bufferedAmount },
        });
        streamer.start();
        state.frameStreamers.add(streamer);
      });
    }

    socket.on("message", (raw, isBinary) => {
      const message = parseClientMessage(raw, isBinary);
      if (message === null || streamer?.handle(message) === "invalid") {
        socket.close(CLOSE_CODES.badClientMessage, "bad client message");
        return;
      }
      for (const listener of this.messageListeners) {
        listener(connection, message);
      }
    });
    socket.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
      clearTimeout(maxAge);
      if (streamer !== null) {
        streamer.stop();
        state.frameStreamers.delete(streamer);
      }
      this.release(connection, userId);
    });
  }

  private release(connection: RunConnection, userId: string): void {
    if (!this.connections.delete(connection)) {
      return;
    }
    const remaining = (this.openByUser.get(userId) ?? 1) - 1;
    if (remaining <= 0) {
      this.openByUser.delete(userId);
    } else {
      this.openByUser.set(userId, remaining);
    }
    this.state.connections.open -= 1;
  }
}
