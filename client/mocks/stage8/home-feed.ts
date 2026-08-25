import type { IncomingMessage, ServerResponse } from "node:http";
import { REQUEST_ID_HEADER } from "../config";
import { MockApiError } from "../factories/errors";
import { QueryReader } from "../factories/pagination";
import { errorResponse, requireUser, resolveRequestId, type ApiContext } from "../handlers/api";
import type { MockState } from "../state";
import type { EventEnvelope, RunEvent } from "../types";
import { runHomeAction } from "./home-script";
import { stageEight } from "./store";

export const HOME_FEED_PATH = "/api/v1/feeds/home";

export const HOME_RUN_EVENT_TYPES: readonly string[] = [
  "run.created",
  "run.status_changed",
  "run.finished",
  "budget.exhausted",
];

const SCRIPTED_ACTIONS = ["notification", "invalidate", "finding"] as const;

type ScriptedAction = (typeof SCRIPTED_ACTIONS)[number];

const MILLISECONDS_PER_SECOND = 1000;
const DROP_DELAY_MS = 40;

interface HomeConnection {
  response: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
  maxAge: ReturnType<typeof setTimeout>;
  unsubscribe: () => void;
}

function frame(envelope: EventEnvelope): string {
  return `event: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function toHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function writeFailure(
  response: ServerResponse,
  error: MockApiError,
  requestId: string,
): Promise<void> {
  const failure = errorResponse(error, requestId);
  response.statusCode = failure.status;
  failure.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(await failure.text());
}

export class HomeFeed {
  private readonly state: MockState;
  private readonly connections = new Set<HomeConnection>();
  private readonly timers = new Map<ScriptedAction, ReturnType<typeof setTimeout>>();

  constructor(state: MockState) {
    this.state = state;
  }

  get openCount(): number {
    return this.connections.size;
  }

  async open(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const requestId = resolveRequestId(
      typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : null,
    );
    const context: ApiContext = {
      request: new Request(url, { method: "GET", headers: toHeaders(request) }),
      params: {},
      url,
      requestId,
      state: this.state,
    };
    try {
      await requireUser(context, "viewer");
      const query = new QueryReader(url.searchParams);
      const targetId = query.uuid("target_id");
      query.finish();
      this.state.stageTwo.ensure();
      this.state.stageFive.findings.ensure();
      this.accept(request, response, targetId?.toLowerCase(), requestId);
    } catch (error) {
      await writeFailure(
        response,
        error instanceof MockApiError
          ? error
          : new MockApiError(500, "internal_error", "Internal server error"),
        requestId,
      );
    }
  }

  dropAll(): number {
    const dropped = this.connections.size;
    for (const connection of [...this.connections]) {
      this.release(connection);
      connection.response.destroy();
    }
    return dropped;
  }

  private accept(
    request: IncomingMessage,
    response: ServerResponse,
    targetId: string | undefined,
    requestId: string,
  ): void {
    const { state } = this;
    request.socket.setNoDelay(true);
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      [REQUEST_ID_HEADER]: requestId,
    });
    const send = (envelope: EventEnvelope) => {
      if (!response.writableEnded && !response.destroyed) {
        response.write(frame(envelope));
      }
    };
    send({
      type: "stream.hello",
      run_id: null,
      seq: null,
      ts: new Date().toISOString(),
      payload: {
        run_id: null,
        head_seq: null,
        resumed_from: null,
        heartbeat_seconds: Math.max(
          1,
          Math.round(state.config.heartbeatIntervalMs / MILLISECONDS_PER_SECOND),
        ),
        limits: null,
        feed: "home",
      },
    });

    const unsubscribers = [
      state.subscribeAll((event) => {
        if (this.matchesRunEvent(event, targetId)) {
          send({ ...event });
        }
      }),
      state.stageFive.findings.subscribe((event) => {
        if (event.type === "finding.created" && this.matchesFinding(event, targetId)) {
          send({ ...event });
        }
      }),
      stageEight.bus.subscribe((event) => {
        if (event.run_id === null || this.runMatchesTarget(event.run_id, targetId)) {
          send({ ...event });
        }
      }),
    ];
    const connection: HomeConnection = {
      response,
      heartbeat: setInterval(() => {
        if (!response.writableEnded && !response.destroyed) {
          response.write(": ping\n\n");
        }
      }, state.config.heartbeatIntervalMs),
      maxAge: setTimeout(() => {
        send({
          type: "stream.closing",
          run_id: null,
          seq: null,
          ts: new Date().toISOString(),
          payload: { reason: "max_age" },
        });
        this.release(connection);
        response.end();
      }, state.config.streamMaxAgeMs),
      unsubscribe: () => {
        for (const unsubscribe of unsubscribers) {
          unsubscribe();
        }
      },
    };
    this.connections.add(connection);
    request.on("close", () => this.release(connection));
    response.on("close", () => this.release(connection));
    this.startScript();

    if (state.faults.consume("feed_drop")) {
      setTimeout(() => {
        this.release(connection);
        response.destroy();
      }, DROP_DELAY_MS);
    }
  }

  private runMatchesTarget(runId: string, targetId: string | undefined): boolean {
    const entry = this.state.stageTwo.findRun(runId);
    return entry !== undefined && (targetId === undefined || entry.run.target_id === targetId);
  }

  private matchesRunEvent(event: RunEvent, targetId: string | undefined): boolean {
    return (
      HOME_RUN_EVENT_TYPES.includes(event.type) &&
      event.run_id !== null &&
      this.runMatchesTarget(event.run_id, targetId)
    );
  }

  private matchesFinding(event: EventEnvelope, targetId: string | undefined): boolean {
    if (targetId === undefined) {
      return true;
    }
    const findingId: unknown = Reflect.get(event.payload, "finding_id");
    if (typeof findingId !== "string") {
      return false;
    }
    return this.state.stageFive.findings.find(findingId)?.target_id === targetId;
  }

  private intervalMs(action: ScriptedAction): number {
    const { feed } = stageEight;
    switch (action) {
      case "notification":
        return feed.notificationIntervalMs;
      case "invalidate":
        return feed.invalidateIntervalMs;
      case "finding":
        return feed.findingIntervalMs;
    }
  }

  private schedule(action: ScriptedAction): void {
    this.timers.set(
      action,
      setTimeout(() => {
        if (!stageEight.feed.paused) {
          runHomeAction(this.state, action);
        }
        this.schedule(action);
      }, this.intervalMs(action)),
    );
  }

  private startScript(): void {
    if (this.timers.size > 0) {
      return;
    }
    for (const action of SCRIPTED_ACTIONS) {
      this.schedule(action);
    }
  }

  private stopScript(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private release(connection: HomeConnection): void {
    if (!this.connections.delete(connection)) {
      return;
    }
    clearInterval(connection.heartbeat);
    clearTimeout(connection.maxAge);
    connection.unsubscribe();
    if (this.connections.size === 0) {
      this.stopScript();
    }
  }
}
