import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseStreamMessage,
  type EventType,
  type KnownStreamEvent,
  type PayloadOfEvent,
} from "@/features/streams/events";
import { qk } from "@/lib/api/query-keys";
import { cachedRun, makeRun, RUN_ID } from "@/tests/utils/run-detail-fixtures";
import {
  FIXTURE_RUN_SCENARIO_ID,
  FIXTURE_STEP_ID,
  knownEnvelope,
} from "@/tests/utils/stream-fixtures";
import {
  applyRunEvent,
  isPersistedRunEvent,
  patchRunFromEvent,
  reconcileRunWithEvents,
} from "./apply-run-event";
import type { RunEventsPage } from "./run-event-pages";
import { RunEventStore } from "./run-event-store";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function event<Type extends EventType>(
  type: Type,
  seq: number | null,
  payload: Partial<PayloadOfEvent<Type>> = {},
): KnownStreamEvent {
  const parsed = parseStreamMessage(knownEnvelope(type, seq, payload));
  if (parsed.kind !== "known") {
    throw new Error(`fixture ${type} is not a known event`);
  }
  return parsed.event;
}

function emptyPage(lastSeq: number): RunEventsPage {
  return {
    events: [],
    lowestSeq: lastSeq === 0 ? null : lastSeq,
    highestSeq: lastSeq,
    headSeq: lastSeq,
    hasMore: false,
    skipped: 0,
  };
}

function setup(runOverrides: Parameters<typeof makeRun>[0] = {}, loadedThrough = 0) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(qk.runs.detail(RUN_ID), makeRun(runOverrides));
  const store = new RunEventStore(RUN_ID);
  store.load(emptyPage(loadedThrough));
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  return { queryClient, store, invalidate };
}

function invalidatedKeys(invalidate: {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
}): unknown[] {
  return invalidate.mock.calls.map((call) => (call[0] as { queryKey: unknown }).queryKey);
}

describe("applyRunEvent ordering", () => {
  it("applies consecutive events in order and patches the cached run", () => {
    const { queryClient, store } = setup();

    const results = [
      applyRunEvent(
        queryClient,
        store,
        event("run.status_changed", 1, { status: "running", previous: "queued" }),
      ),
      applyRunEvent(
        queryClient,
        store,
        event("run.progress", 2, { scenarios_total: 4, scenarios_done: 1, pass: 1 }),
      ),
      applyRunEvent(
        queryClient,
        store,
        event("budget.updated", 3, {
          max_usd: 5,
          spent_usd: 0.25,
          max_minutes: 30,
          elapsed_ms: 9000,
        }),
      ),
    ];

    expect(results.map((result) => result.outcome)).toEqual(["applied", "applied", "applied"]);
    expect(store.getSnapshot().events.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(cachedRun(queryClient)).toMatchObject({
      status: "running",
      counters: { scenarios_done: 1, pass: 1 },
      budget: { spent_usd: 0.25, elapsed_ms: 9000 },
      event_head_seq: 3,
    });
  });

  it("drops a duplicate without patching twice", () => {
    const { queryClient, store } = setup({}, 1);
    applyRunEvent(queryClient, store, event("run.progress", 2, { pass: 1 }));

    const again = applyRunEvent(queryClient, store, event("run.progress", 2, { pass: 9 }));
    const older = applyRunEvent(queryClient, store, event("run.progress", 1, { pass: 7 }));

    expect(again.outcome).toBe("duplicate");
    expect(older.outcome).toBe("duplicate");
    expect(cachedRun(queryClient)?.counters.pass).toBe(1);
    expect(store.getSnapshot().events).toHaveLength(1);
  });

  it("refuses an event after a gap and leaves the cache and log alone", () => {
    const { queryClient, store } = setup({}, 2);

    const result = applyRunEvent(queryClient, store, event("run.progress", 5, { pass: 3 }));

    expect(result).toEqual({ outcome: "gap", expected: 3, received: 5 });
    expect(cachedRun(queryClient)?.counters.pass).toBe(0);
    expect(store.getSnapshot().events).toHaveLength(0);
    expect(store.getSnapshot().gap).toEqual({ expected: 3, received: 5 });
  });

  it("applies the missing seq after a replay and the log ends gap free", () => {
    const { queryClient, store } = setup({}, 2);
    applyRunEvent(queryClient, store, event("run.progress", 5));
    store.clearGap();

    const replayed = [3, 4, 5].map((seq) =>
      applyRunEvent(queryClient, store, event("run.progress", seq, { pass: seq })),
    );

    expect(replayed.map((result) => result.outcome)).toEqual(["applied", "applied", "applied"]);
    expect(store.getSnapshot().events.map((entry) => entry.seq)).toEqual([3, 4, 5]);
    expect(cachedRun(queryClient)?.counters.pass).toBe(5);
  });

  it("does not touch a run that is not cached", () => {
    const queryClient = new QueryClient();
    const store = new RunEventStore(RUN_ID);
    store.load(emptyPage(0));

    const result = applyRunEvent(queryClient, store, event("run.progress", 1));

    expect(result.outcome).toBe("applied");
    expect(cachedRun(queryClient)).toBeUndefined();
  });
});

describe("applyRunEvent run patches", () => {
  it("sets started_at on the first status change away from queued only", () => {
    const { queryClient, store } = setup({ status: "queued", started_at: null });

    applyRunEvent(
      queryClient,
      store,
      event("run.status_changed", 1, { status: "queued", previous: "queued" }),
    );
    expect(cachedRun(queryClient)?.started_at).toBeNull();

    applyRunEvent(
      queryClient,
      store,
      event("run.status_changed", 2, { status: "running", previous: "queued" }),
    );
    expect(cachedRun(queryClient)?.started_at).not.toBeNull();
    const startedAt = cachedRun(queryClient)?.started_at;

    applyRunEvent(
      queryClient,
      store,
      event("run.status_changed", 3, { status: "canceling", previous: "running" }),
    );
    expect(cachedRun(queryClient)).toMatchObject({ status: "canceling", started_at: startedAt });
  });

  it("applies run.finished to status, counters, spent cost and the finish time", () => {
    const { queryClient, store } = setup();

    applyRunEvent(
      queryClient,
      store,
      event("run.finished", 1, {
        status: "completed",
        counters: {
          scenarios_total: 4,
          scenarios_done: 4,
          pass: 3,
          fail: 1,
          flaky: 0,
          uncertain: 0,
          skipped: 0,
          steps_recorded: 22,
        },
        spent_usd: 1.5,
        duration_ms: 61_000,
      }),
    );

    expect(cachedRun(queryClient)).toMatchObject({
      status: "completed",
      counters: { scenarios_done: 4, pass: 3, fail: 1, steps_recorded: 22 },
      budget: { max_usd: 5, spent_usd: 1.5 },
      finished_at: expect.any(String),
      event_head_seq: 1,
    });
    expect(store.getSnapshot().finished).toBe(true);
  });

  it("never lowers event_head_seq", () => {
    const { queryClient, store } = setup({ event_head_seq: 40 }, 0);

    applyRunEvent(queryClient, store, event("run.progress", 1));

    expect(cachedRun(queryClient)?.event_head_seq).toBe(40);
  });

  it("exports the patch used to reconcile a stale run with newer history", () => {
    const { queryClient } = setup({ status: "running", event_head_seq: 2 });

    reconcileRunWithEvents(queryClient, RUN_ID, [
      event("run.progress", 1, { pass: 1 }),
      event("run.progress", 2, { pass: 2 }),
      event("run.progress", 3, { pass: 3 }),
      event("run.status_changed", 4, { status: "failed", previous: "running" }),
      event("stream.heartbeat", null),
    ]);

    expect(cachedRun(queryClient)).toMatchObject({
      status: "failed",
      counters: { pass: 3 },
      event_head_seq: 4,
    });
  });

  it("patches a single persisted event on its own", () => {
    const { queryClient } = setup();
    const progress = event("run.progress", 1, { skipped: 2 });
    if (!isPersistedRunEvent(progress)) {
      throw new Error("run.progress must be persisted");
    }

    patchRunFromEvent(queryClient, RUN_ID, progress);

    expect(cachedRun(queryClient)?.counters.skipped).toBe(2);
  });
});

describe("applyRunEvent terminal handling", () => {
  it("refetches the run, scenarios, sessions and lists at once on run.finished", () => {
    const { queryClient, store, invalidate } = setup();

    applyRunEvent(queryClient, store, event("run.finished", 1));

    const keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(qk.runs.detail(RUN_ID));
    expect(keys).toContainEqual(qk.runs.scenarios(RUN_ID));
    expect(keys).toContainEqual(qk.runs.browserSessions(RUN_ID));
    expect(keys).toContainEqual(qk.runs.lists());
  });

  it("flushes throttled invalidations that are still waiting when the run finishes", () => {
    const { queryClient, store, invalidate } = setup();
    applyRunEvent(queryClient, store, event("scenario.started", 1));
    expect(invalidate).not.toHaveBeenCalled();

    applyRunEvent(queryClient, store, event("run.finished", 2));

    expect(invalidatedKeys(invalidate)).toContainEqual(
      qk.runScenarios.detail(FIXTURE_RUN_SCENARIO_ID),
    );
    vi.advanceTimersByTime(5000);
    const scenarioRefetches = invalidatedKeys(invalidate).filter(
      (key) => JSON.stringify(key) === JSON.stringify(qk.runs.scenarios(RUN_ID)),
    );
    expect(scenarioRefetches).toHaveLength(2);
  });

  it("refreshes from REST when a terminal status arrives without run.finished", () => {
    const { queryClient, store, invalidate } = setup();

    applyRunEvent(
      queryClient,
      store,
      event("run.status_changed", 1, { status: "canceled", previous: "canceling" }),
    );

    expect(invalidatedKeys(invalidate)).toContainEqual(qk.runs.detail(RUN_ID));
    expect(store.getSnapshot().finished).toBe(false);
  });

  it("does not refetch for a non terminal status change", () => {
    const { queryClient, store, invalidate } = setup();

    applyRunEvent(
      queryClient,
      store,
      event("run.status_changed", 1, { status: "canceling", previous: "running" }),
    );

    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("applyRunEvent throttled invalidation", () => {
  it("coalesces a burst of scenario and step events into one trailing refetch", () => {
    const { queryClient, store, invalidate } = setup();

    applyRunEvent(queryClient, store, event("scenario.queued", 1));
    vi.advanceTimersByTime(300);
    applyRunEvent(queryClient, store, event("scenario.started", 2));
    vi.advanceTimersByTime(300);
    applyRunEvent(queryClient, store, event("step.recorded", 3));
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);

    const keys = invalidatedKeys(invalidate);
    expect(
      keys.filter((key) => JSON.stringify(key) === JSON.stringify(qk.runs.scenarios(RUN_ID))),
    ).toHaveLength(1);
    expect(
      keys.filter(
        (key) =>
          JSON.stringify(key) === JSON.stringify(qk.runScenarios.detail(FIXTURE_RUN_SCENARIO_ID)),
      ),
    ).toHaveLength(1);
  });

  it("starts a new one second window after the trailing refetch ran", () => {
    const { queryClient, store, invalidate } = setup();

    applyRunEvent(queryClient, store, event("step.recorded", 1));
    vi.advanceTimersByTime(1000);
    const first = invalidate.mock.calls.length;
    applyRunEvent(queryClient, store, event("step.recorded", 2));
    vi.advanceTimersByTime(999);
    expect(invalidate.mock.calls.length).toBe(first);

    vi.advanceTimersByTime(1);
    expect(invalidate.mock.calls.length).toBeGreaterThan(first);
  });

  it("invalidates the browser sessions for session events only", () => {
    const { queryClient, store, invalidate } = setup();

    applyRunEvent(queryClient, store, event("browser_session.started", 1));
    applyRunEvent(queryClient, store, event("browser_session.ended", 2));
    vi.advanceTimersByTime(1000);

    expect(invalidatedKeys(invalidate)).toEqual([qk.runs.browserSessions(RUN_ID)]);
  });

  it("invalidates the graded step and its run scenario for step.graded", () => {
    const { queryClient, store, invalidate } = setup();

    applyRunEvent(queryClient, store, event("step.graded", 1));
    vi.advanceTimersByTime(1000);

    const keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(qk.steps.detail(FIXTURE_STEP_ID));
    expect(keys).toContainEqual(qk.runScenarios.detail(FIXTURE_RUN_SCENARIO_ID));
  });

  it("does not invalidate anything for patch only and seed events", () => {
    const { queryClient, store, invalidate } = setup();

    applyRunEvent(queryClient, store, event("run.progress", 1));
    applyRunEvent(queryClient, store, event("budget.updated", 2));
    applyRunEvent(queryClient, store, event("budget.exhausted", 3));
    applyRunEvent(queryClient, store, event("seed.progress", 4));
    vi.advanceTimersByTime(5000);

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does not schedule anything for a duplicate or a gap", () => {
    const { queryClient, store, invalidate } = setup({}, 1);

    applyRunEvent(queryClient, store, event("step.recorded", 1));
    applyRunEvent(queryClient, store, event("step.recorded", 7));
    vi.advanceTimersByTime(5000);

    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("applyRunEvent ephemeral events", () => {
  it("keeps stream events out of the log and in the debug list", () => {
    const { queryClient, store } = setup();

    const hello = applyRunEvent(queryClient, store, event("stream.hello", null));
    const heartbeat = applyRunEvent(queryClient, store, event("stream.heartbeat", null));

    expect(hello.outcome).toBe("ephemeral");
    expect(heartbeat.outcome).toBe("ephemeral");
    expect(store.getSnapshot().events).toHaveLength(0);
    expect(store.getSnapshot().streamEvents.map((entry) => entry.type)).toEqual([
      "stream.hello",
      "stream.heartbeat",
    ]);
    expect(store.getLastSeq()).toBe(0);
  });

  it("ignores frames: the provider hands them to the frame bus", () => {
    const { queryClient, store } = setup();

    const result = applyRunEvent(queryClient, store, event("tile.frame", null));

    expect(result.outcome).toBe("ephemeral");
    expect(store.getSnapshot().events).toHaveLength(0);
    expect(store.getSnapshot().streamEvents).toHaveLength(0);
  });
});
