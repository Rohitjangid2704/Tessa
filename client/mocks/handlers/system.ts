import { createHash } from "node:crypto";
import { http } from "msw";
import { IDEMPOTENCY_KEY_HEADER } from "../config";
import { conflict, dependencyUnavailable, idempotencyKeyRequired } from "../factories/errors";
import { FieldValidator, parseJsonObject } from "../factories/validation";
import { startHelloRun } from "../simulation/hello-run";
import type { MockState } from "../state";
import type {
  DependencyCheck,
  DependencyHealth,
  HealthStatus,
  RootInfo,
  RunHandle,
} from "../types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";
import type { DependencyName } from "../server/faults";

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{8,128}$/;
const DEFAULT_HELLO_TICKS = 5;
const DEFAULT_HELLO_TICK_INTERVAL_MS = 1000;
const MAX_HELLO_TICKS = 60;
const MIN_HELLO_TICK_INTERVAL_MS = 100;
const MAX_HELLO_TICK_INTERVAL_MS = 10_000;

const HEALTHY_DEPENDENCIES: Record<DependencyName, DependencyCheck> = {
  db: { status: "up", latency_ms: 3, detail: null },
  temporal: { status: "up", latency_ms: 5, detail: null },
  laya: { status: "up", latency_ms: 12, detail: "HTTP 200" },
};

const DOWN_DETAILS: Record<DependencyName, string> = {
  db: "OperationalError",
  temporal: "RuntimeError",
  laya: "ConnectError",
};

function checkDependency(state: MockState, name: DependencyName): DependencyCheck {
  if (state.faults.isDependencyDown(name)) {
    return { status: "down", latency_ms: null, detail: DOWN_DETAILS[name] };
  }
  return { ...HEALTHY_DEPENDENCIES[name] };
}

function readRoot(): Response {
  const body: RootInfo = { name: "Tessa API", status: "ready" };
  return jsonResponse(body);
}

function readHealth(): Response {
  const body: HealthStatus = { status: "ok" };
  return jsonResponse(body);
}

async function readDependencies(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const body: DependencyHealth = {
    db: checkDependency(context.state, "db"),
    temporal: checkDependency(context.state, "temporal"),
    laya: checkDependency(context.state, "laya"),
    storage: { status: "unconfigured", latency_ms: null, detail: "storage is defined in Phase 1" },
  };
  return jsonResponse(body);
}

function readIdempotencyKey(request: Request): string {
  const key = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (key === null || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw idempotencyKeyRequired();
  }
  return key;
}

function hashRequest(method: string, path: string, body: string): string {
  return createHash("sha256")
    .update(method.toUpperCase())
    .update("\n")
    .update(path)
    .update("\n")
    .update(body)
    .digest("hex");
}

async function createHelloRun(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const key = readIdempotencyKey(context.request);
  const raw = await context.request.text();
  const body = parseJsonObject(raw);
  const validator = new FieldValidator("body");
  const params = validator.finish({
    ticks: validator.integer(body, "ticks", {
      min: 1,
      max: MAX_HELLO_TICKS,
      fallback: DEFAULT_HELLO_TICKS,
    }),
    tick_interval_ms: validator.integer(body, "tick_interval_ms", {
      min: MIN_HELLO_TICK_INTERVAL_MS,
      max: MAX_HELLO_TICK_INTERVAL_MS,
      fallback: DEFAULT_HELLO_TICK_INTERVAL_MS,
    }),
    include_laya: validator.boolean(body, "include_laya", true),
  });

  const { state } = context;
  const storeKey = `${user.id}:${key}`;
  const requestHash = hashRequest(context.request.method, context.url.pathname, raw);
  const stored = state.idempotency.get(storeKey);
  if (stored !== undefined) {
    if (stored.requestHash !== requestHash) {
      throw conflict(
        "idempotency_conflict",
        "This Idempotency-Key was already used with a different request",
      );
    }
    return jsonResponse(stored.body, {
      status: stored.status,
      headers: { "Idempotency-Replayed": "true" },
    });
  }

  if (state.faults.hello503) {
    throw dependencyUnavailable("temporal", "Temporal is not running");
  }

  const run = startHelloRun(state, user, params);
  const handle: RunHandle = {
    run_id: run.id,
    workflow_id: `hello-${run.id}`,
    kind: "hello",
    status: "queued",
    created_at: run.events[0]?.ts ?? new Date().toISOString(),
  };
  state.idempotency.set(storeKey, { requestHash, status: 202, body: handle });
  return jsonResponse(handle, { status: 202 });
}

export const systemHandlers = [
  http.get(/^https?:\/\/[^/]+\/?$/, api(readRoot)),
  http.get("*/health", api(readHealth)),
  http.get("*/health/dependencies", api(readDependencies)),
  http.post("*/api/v1/system/hello-runs", api(createHelloRun)),
];
