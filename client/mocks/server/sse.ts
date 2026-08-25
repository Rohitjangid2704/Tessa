import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { REQUEST_ID_HEADER } from "../config";
import { MockApiError } from "../factories/errors";
import { QueryReader } from "../factories/pagination";
import { errorResponse, requireUser, resolveRequestId, type ApiContext } from "../handlers/api";
import { RUN_KINDS } from "../stage2/support";
import { SCRIPT_ACTIONS, type ScriptAction } from "../stage5/findings-script";
import { coverageBus } from "../stage6/coverage-bus";
import { HOME_FEED_PATH, HomeFeed } from "../stage8/home-feed";
import type { MockState } from "../state";
import type { EventEnvelope, RunEvent } from "../types";
import type { RunKind } from "@/lib/api/types";

export const FEED_PATH_PREFIX = "/api/v1/feeds/";
export const RUNS_FEED_PATH = `${FEED_PATH_PREFIX}runs`;
export const FINDINGS_FEED_PATH = `${FEED_PATH_PREFIX}findings`;
export const COVERAGE_FEED_PATH = `${FEED_PATH_PREFIX}coverage`;

export const RUNS_FEED_EVENT_TYPES: readonly string[] = [
  "run.created",
  "run.status_changed",
  "run.progress",
  "run.finished",
  "budget.updated",
  "budget.exhausted",
  "run.stop_requested",
];

const MILLISECONDS_PER_SECOND = 1000;
const DROP_DELAY_MS = 40;

interface FeedFilter {
  targetId: string | undefined;
  kinds: RunKind[] | undefined;
  runId: string | undefined;
}

interface FindingsFeedFilter {
  targetId: string | undefined;
}

interface CoverageFeedFilter {
  targetId: string | undefined;
}

interface FeedConnection {
  kind: "runs" | "findings" | "coverage";
  response: ServerResponse;
  filter: FeedFilter | FindingsFeedFilter | CoverageFeedFilter;
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

export class FeedHub {
  private readonly state: MockState;
  private readonly connections = new Set<FeedConnection>();
  private readonly findingsTimers = new Map<ScriptAction, ReturnType<typeof setTimeout>>();
  private readonly home: HomeFeed;

  constructor(state: MockState) {
    this.state = state;
    this.home = new HomeFeed(state);
    state.stageTwo.feedControl = {
      open: () => this.openCount,
      drop: () => this.dropAll(),
    };
  }

  get openCount(): number {
    return this.connections.size + this.home.openCount;
  }

  wrap(listener: RequestListener): RequestListener {
    return (request, response) => {
      const url = new URL(request.url ?? "/", "http://mock.invalid");
      if (request.method === "GET" && url.pathname === RUNS_FEED_PATH) {
        void this.open(request, response, url);
        return;
      }
      if (request.method === "GET" && url.pathname === FINDINGS_FEED_PATH) {
        void this.openFindings(request, response, url);
        return;
      }
      if (request.method === "GET" && url.pathname === COVERAGE_FEED_PATH) {
        void this.openCoverage(request, response, url);
        return;
      }
      if (request.method === "GET" && url.pathname === HOME_FEED_PATH) {
        void this.home.open(request, response, url);
        return;
      }
      listener(request, response);
    };
  }

  dropAll(): number {
    const dropped = this.connections.size;
    for (const connection of [...this.connections]) {
      this.release(connection);
      connection.response.destroy();
    }
    return dropped + this.home.dropAll();
  }

  closeAll(): void {
    this.dropAll();
  }

  private async open(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
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
      const filter = this.readFilter(url);
      this.state.stageTwo.ensure();
      this.accept(request, response, filter, requestId);
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

  private readFilter(url: URL): FeedFilter {
    const query = new QueryReader(url.searchParams);
    const targetId = query.uuid("target_id");
    const kinds = query.enumList("kind", RUN_KINDS);
    const runId = query.uuid("run_id");
    query.finish();
    return {
      targetId: targetId?.toLowerCase(),
      kinds,
      runId: runId?.toLowerCase(),
    };
  }

  private accept(
    request: IncomingMessage,
    response: ServerResponse,
    filter: FeedFilter,
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
    const heartbeatSeconds = Math.max(
      1,
      Math.round(state.config.heartbeatIntervalMs / MILLISECONDS_PER_SECOND),
    );
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
        heartbeat_seconds: heartbeatSeconds,
        limits: null,
        feed: "runs",
      },
    });

    const connection: FeedConnection = {
      kind: "runs",
      response,
      filter,
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
      unsubscribe: state.subscribeAll((event) => {
        if (this.matches(event, filter)) {
          send({ ...event });
        }
      }),
    };
    this.connections.add(connection);
    request.on("close", () => this.release(connection));
    response.on("close", () => this.release(connection));

    if (state.faults.consume("feed_drop")) {
      setTimeout(() => {
        this.release(connection);
        response.destroy();
      }, DROP_DELAY_MS);
    }
  }

  private matches(event: RunEvent, filter: FeedFilter): boolean {
    if (!RUNS_FEED_EVENT_TYPES.includes(event.type) || event.run_id === null) {
      return false;
    }
    const entry = this.state.stageTwo.findRun(event.run_id);
    if (entry === undefined) {
      return false;
    }
    return (
      (filter.runId === undefined || entry.run.id === filter.runId) &&
      (filter.targetId === undefined || entry.run.target_id === filter.targetId) &&
      (filter.kinds === undefined || filter.kinds.includes(entry.run.kind))
    );
  }

  private async openFindings(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
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
      this.state.stageFive.findings.ensure();
      this.acceptFindings(request, response, { targetId: targetId?.toLowerCase() }, requestId);
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

  private acceptFindings(
    request: IncomingMessage,
    response: ServerResponse,
    filter: FindingsFeedFilter,
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
    const heartbeatSeconds = Math.max(
      1,
      Math.round(state.config.heartbeatIntervalMs / MILLISECONDS_PER_SECOND),
    );
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
        heartbeat_seconds: heartbeatSeconds,
        limits: null,
        feed: "findings",
      },
    });

    const connection: FeedConnection = {
      kind: "findings",
      response,
      filter,
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
      unsubscribe: state.stageFive.findings.subscribe((event) => {
        if (this.matchesFinding(event, filter)) {
          send({ ...event });
        }
      }),
    };
    this.connections.add(connection);
    request.on("close", () => this.release(connection));
    response.on("close", () => this.release(connection));
    this.startFindingsScript();

    if (state.faults.consume("feed_drop")) {
      setTimeout(() => {
        this.release(connection);
        response.destroy();
      }, DROP_DELAY_MS);
    }
  }

  private matchesFinding(event: EventEnvelope, filter: FindingsFeedFilter): boolean {
    if (filter.targetId === undefined) {
      return true;
    }
    const findingId: unknown = Reflect.get(event.payload, "finding_id");
    if (typeof findingId !== "string") {
      return false;
    }
    return this.state.stageFive.findings.find(findingId)?.target_id === filter.targetId;
  }

  private findingsOpenCount(): number {
    let count = 0;
    for (const connection of this.connections) {
      if (connection.kind === "findings") {
        count += 1;
      }
    }
    return count;
  }

  private findingsIntervalMs(action: ScriptAction): number {
    const { feed } = this.state.stageFive.findings;
    if (action === "created") {
      return feed.createIntervalMs;
    }
    return action === "moved" ? feed.moveIntervalMs : feed.occurrenceIntervalMs;
  }

  private scheduleFindingsAction(action: ScriptAction): void {
    this.findingsTimers.set(
      action,
      setTimeout(() => {
        const { findings } = this.state.stageFive;
        if (!findings.feed.paused) {
          findings.script.run(action);
        }
        this.scheduleFindingsAction(action);
      }, this.findingsIntervalMs(action)),
    );
  }

  private startFindingsScript(): void {
    if (this.findingsTimers.size > 0) {
      return;
    }
    for (const action of SCRIPT_ACTIONS) {
      this.scheduleFindingsAction(action);
    }
  }

  private stopFindingsScript(): void {
    for (const timer of this.findingsTimers.values()) {
      clearTimeout(timer);
    }
    this.findingsTimers.clear();
  }

  private async openCoverage(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
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
      this.acceptCoverage(request, response, { targetId: targetId?.toLowerCase() }, requestId);
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

  private acceptCoverage(
    request: IncomingMessage,
    response: ServerResponse,
    filter: CoverageFeedFilter,
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
    const heartbeatSeconds = Math.max(
      1,
      Math.round(state.config.heartbeatIntervalMs / MILLISECONDS_PER_SECOND),
    );
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
        heartbeat_seconds: heartbeatSeconds,
        limits: null,
        feed: "coverage",
      },
    });

    const unsubscribeBus = coverageBus.subscribe(({ targetId, envelope }) => {
      if (filter.targetId === undefined || filter.targetId === targetId) {
        send({ ...envelope });
      }
    });
    const unsubscribeRuns = state.subscribeAll((event) => {
      if (this.matchesGeneration(event, filter)) {
        send({ ...event });
      }
    });
    const connection: FeedConnection = {
      kind: "coverage",
      response,
      filter,
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
        unsubscribeBus();
        unsubscribeRuns();
      },
    };
    this.connections.add(connection);
    request.on("close", () => this.release(connection));
    response.on("close", () => this.release(connection));

    if (state.faults.consume("feed_drop")) {
      setTimeout(() => {
        this.release(connection);
        response.destroy();
      }, DROP_DELAY_MS);
    }
  }

  private matchesGeneration(event: RunEvent, filter: CoverageFeedFilter): boolean {
    if (event.type !== "generation.progress" || event.run_id === null) {
      return false;
    }
    const entry = this.state.stageTwo.findRun(event.run_id);
    return (
      entry !== undefined && (filter.targetId === undefined || entry.run.target_id === filter.targetId)
    );
  }

  private release(connection: FeedConnection): void {
    if (!this.connections.delete(connection)) {
      return;
    }
    clearInterval(connection.heartbeat);
    clearTimeout(connection.maxAge);
    connection.unsubscribe();
    if (connection.kind === "findings" && this.findingsOpenCount() === 0) {
      this.stopFindingsScript();
    }
  }
}
