import { http, HttpResponse } from "msw";
import type { QueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/api/query-keys";
import type { BrowserSession, Run } from "@/lib/api/types";
import { server } from "./server";
import {
  FIXTURE_RUN_ID,
  FIXTURE_SESSION_ID,
  FIXTURE_TIMESTAMP,
  FIXTURE_USER_ID,
  knownEnvelope,
  type WireEnvelope,
} from "./stream-fixtures";

export const RUN_ID = FIXTURE_RUN_ID;

export const EMPTY_COUNTERS = {
  scenarios_total: 0,
  scenarios_done: 0,
  pass: 0,
  fail: 0,
  flaky: 0,
  uncertain: 0,
  skipped: 0,
  steps_recorded: 0,
} as const;

export function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    kind: "suite",
    target_id: null,
    plan_id: null,
    run_group_id: null,
    status: "running",
    counters: { ...EMPTY_COUNTERS, scenarios_total: 4 },
    budget: { max_usd: 5, spent_usd: 0, max_minutes: 30, elapsed_ms: 0 },
    read_only: false,
    started_at: FIXTURE_TIMESTAMP,
    finished_at: null,
    created_at: FIXTURE_TIMESTAMP,
    trigger: "manual",
    bundle_id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e33",
    config_snapshot: {
      bundle_id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e33",
      bundle_version: 3,
      bundle_hash: "sha256:abc123",
      seed_hash: null,
      clock: { mode: "real", at: FIXTURE_TIMESTAMP },
      models: { judge: { model: "judge-model", effort: "medium" } },
      probe_bank_version: null,
      prompt_template_versions: { discovery: 1 },
      scenario_versions: {},
    },
    event_head_seq: 0,
    workflow_id: "run-workflow-1",
    temporal_ui_url: null,
    stop_requested_at: null,
    created_by: FIXTURE_USER_ID,
    ...overrides,
  };
}

export function makeBrowserSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: FIXTURE_SESSION_ID,
    run_scenario_id: "0198f6f2-7b00-7a00-9d00-000000000001",
    scenario_title: "Open the dashboard",
    attempt: 0,
    status: "active",
    viewport: { width: 1280, height: 800 },
    last_url: null,
    has_recording: false,
    has_trace: false,
    started_at: FIXTURE_TIMESTAMP,
    ended_at: null,
    ...overrides,
  };
}

export function tickEvents(count: number, fromSeq: number = 1): WireEnvelope[] {
  return Array.from({ length: count }, (_, index) =>
    knownEnvelope("hello.tick", fromSeq + index, {
      n: fromSeq + index,
      total: fromSeq + count,
      message: `tick ${fromSeq + index}`,
    }),
  );
}

export interface RunServerState {
  run: Run | null;
  runFailure: { status: number; code?: string } | null;
  events: WireEnvelope[];
  eventsFailure: { status: number } | null;
  sessions: BrowserSession[];
  sessionsFailure: { status: number } | null;
  cancelResponse: Run | { status: number; code: string };
}

export interface RunServerRequests {
  run: number;
  events: URL[];
  sessions: number;
  cancel: number;
}

function errorResponse(status: number, code: string): Response {
  return HttpResponse.json(
    { error: { code, message: `${code} (${status})`, request_id: "req-test-1", details: [] } },
    { status },
  );
}

export function serveRun(initial: Partial<RunServerState> = {}) {
  const state: RunServerState = {
    run: makeRun(),
    runFailure: null,
    events: [],
    eventsFailure: null,
    sessions: [],
    sessionsFailure: null,
    cancelResponse: makeRun({ status: "canceling" }),
    ...initial,
  };
  const requests: RunServerRequests = { run: 0, events: [], sessions: 0, cancel: 0 };

  server.use(
    http.get("*/api/v1/runs/:run_id", () => {
      requests.run += 1;
      if (state.runFailure !== null) {
        return errorResponse(state.runFailure.status, state.runFailure.code ?? "not_found");
      }
      if (state.run === null) {
        return errorResponse(404, "not_found");
      }
      return HttpResponse.json(state.run);
    }),
    http.get("*/api/v1/runs/:run_id/events", ({ request }) => {
      const url = new URL(request.url);
      requests.events.push(url);
      if (state.eventsFailure !== null) {
        return errorResponse(state.eventsFailure.status, "internal_error");
      }
      const before = url.searchParams.get("before_seq");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const order = url.searchParams.get("order") ?? "asc";
      const matching = state.events.filter(
        (event) => before === null || (event.seq ?? 0) < Number(before),
      );
      const ordered = order === "desc" ? [...matching].reverse() : matching;
      const head = state.events.reduce((highest, event) => Math.max(highest, event.seq ?? 0), 0);
      return HttpResponse.json({
        items: ordered.slice(0, limit),
        head_seq: head,
        has_more: ordered.length > limit,
      });
    }),
    http.get("*/api/v1/runs/:run_id/browser-sessions", () => {
      requests.sessions += 1;
      if (state.sessionsFailure !== null) {
        return errorResponse(state.sessionsFailure.status, "internal_error");
      }
      return HttpResponse.json({ items: state.sessions });
    }),
    http.post("*/api/v1/runs/:run_id/cancel", () => {
      requests.cancel += 1;
      const response = state.cancelResponse;
      if ("code" in response) {
        return errorResponse(response.status, response.code);
      }
      return HttpResponse.json(response, { status: 202 });
    }),
  );

  return { state, requests };
}

export function cachedRun(queryClient: QueryClient, runId: string = RUN_ID): Run | undefined {
  return queryClient.getQueryData<Run>(qk.runs.detail(runId));
}
