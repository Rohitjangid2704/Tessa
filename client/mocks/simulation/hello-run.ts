import { newId } from "../factories/ids";
import type { MockState, RunRecord } from "../state";
import type { MockUser, RunCounters } from "../types";

export interface HelloRunParams {
  ticks: number;
  tick_interval_ms: number;
  include_laya: boolean;
}

const LAYA_SMOKE_LATENCY_MS = 14;
const LAYA_OK_STATUS_CODE = 200;

function emptyCounters(): RunCounters {
  return {
    scenarios_total: 0,
    scenarios_done: 0,
    pass: 0,
    fail: 0,
    flaky: 0,
    uncertain: 0,
    skipped: 0,
    steps_recorded: 0,
  };
}

export function startHelloRun(state: MockState, user: MockUser, params: HelloRunParams): RunRecord {
  const run: RunRecord = {
    id: newId(),
    createdBy: user.id,
    events: [],
    finished: false,
    timers: [],
  };
  state.runs.set(run.id, run);
  const startedAt = Date.now();

  state.appendEvent(run, "run.created", {
    kind: "hello",
    target_id: null,
    plan_id: null,
    trigger: "manual",
    created_by: user.id,
    status: "queued",
  });

  let offsetMs = state.config.helloStartDelayMs;
  state.schedule(run, offsetMs, () => {
    state.appendEvent(run, "run.status_changed", {
      status: "running",
      previous: "queued",
      reason: null,
    });
  });

  for (let tickNumber = 1; tickNumber <= params.ticks; tickNumber += 1) {
    offsetMs += params.tick_interval_ms;
    state.schedule(run, offsetMs, () => {
      state.appendEvent(run, "hello.tick", {
        n: tickNumber,
        total: params.ticks,
        message: `hello tick ${tickNumber} of ${params.ticks}`,
      });
    });
  }

  if (params.include_laya) {
    offsetMs += state.config.helloFinishDelayMs;
    state.schedule(run, offsetMs, () => {
      state.appendEvent(run, "hello.laya", {
        ok: true,
        latency_ms: LAYA_SMOKE_LATENCY_MS,
        status_code: LAYA_OK_STATUS_CODE,
        error: null,
      });
    });
  }

  offsetMs += state.config.helloFinishDelayMs;
  state.schedule(run, offsetMs, () => {
    run.finished = true;
    state.appendEvent(run, "run.finished", {
      status: "completed",
      counters: emptyCounters(),
      spent_usd: 0,
      duration_ms: Date.now() - startedAt,
    });
  });

  return run;
}
