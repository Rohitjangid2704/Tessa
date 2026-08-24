import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { ADMIN_USER } from "@/mocks/factories/users";
import { newId } from "@/mocks/factories/ids";
import { mockState, type RunRecord } from "@/mocks/state";
import { FIXTURE_RUN_ID } from "@/tests/utils/stream-fixtures";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://api.test";
});

vi.mock("@/lib/auth/token-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/token-client")>();
  const { mintApiToken: mint } = await import("@/tests/utils/tokens");
  return { ...original, getToken: () => mint(), refreshToken: () => mint() };
});

const { createRunEventsResync, fetchRunEvents, runEventsQuery, RUN_EVENTS_PAGE_LIMIT } =
  await import("./run-events");

function createRun(tickCount: number): RunRecord {
  const run: RunRecord = {
    id: newId(),
    createdBy: ADMIN_USER.id,
    events: [],
    finished: false,
    timers: [],
  };
  mockState.runs.set(run.id, run);
  mockState.appendEvent(run, "run.created", {
    kind: "hello",
    target_id: null,
    plan_id: null,
    trigger: "manual",
    created_by: ADMIN_USER.id,
    status: "queued",
  });
  for (let tick = 1; tick <= tickCount; tick += 1) {
    mockState.appendEvent(run, "hello.tick", {
      n: tick,
      total: tickCount,
      message: `tick ${tick}`,
    });
  }
  return run;
}

describe("fetchRunEvents", () => {
  it("loads a short log in one page", async () => {
    const run = createRun(3);

    const loaded = await fetchRunEvents(run.id);

    expect(loaded.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(loaded.events.map((event) => event.type)).toEqual([
      "run.created",
      "hello.tick",
      "hello.tick",
      "hello.tick",
    ]);
    expect(loaded).toMatchObject({ lastSeq: 4, headSeq: 4, skipped: 0 });
  });

  it("follows has_more across pages and keeps the order", async () => {
    const run = createRun(RUN_EVENTS_PAGE_LIMIT * 2 + 49);

    const loaded = await fetchRunEvents(run.id);

    expect(loaded.events).toHaveLength(RUN_EVENTS_PAGE_LIMIT * 2 + 50);
    expect(loaded.events.map((event) => event.seq)).toEqual(
      Array.from({ length: RUN_EVENTS_PAGE_LIMIT * 2 + 50 }, (_, index) => index + 1),
    );
    expect(loaded.lastSeq).toBe(RUN_EVENTS_PAGE_LIMIT * 2 + 50);
  });

  it("starts after afterSeq and returns nothing new for an up to date log", async () => {
    const run = createRun(5);

    const tail = await fetchRunEvents(run.id, { afterSeq: 4 });
    const none = await fetchRunEvents(run.id, { afterSeq: 6 });

    expect(tail.events.map((event) => event.seq)).toEqual([5, 6]);
    expect(none.events).toEqual([]);
    expect(none).toMatchObject({ lastSeq: 6, headSeq: 6 });
  });

  it("counts and skips events it does not know without losing their seq", async () => {
    const run = createRun(1);
    mockState.appendRawEvent(run, "scenario.queued", { anything: true });
    mockState.appendEvent(run, "hello.tick", { n: 2, total: 2, message: "tick 2" });

    const loaded = await fetchRunEvents(run.id);

    expect(loaded.events.map((event) => event.seq)).toEqual([1, 2, 4]);
    expect(loaded.skipped).toBe(1);
    expect(loaded.lastSeq).toBe(4);
  });

  it("throws an ApiError for an unknown run", async () => {
    const error = await fetchRunEvents(FIXTURE_RUN_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("runEventsQuery", () => {
  it("keys the query by run and never caches or retries", () => {
    const options = runEventsQuery(FIXTURE_RUN_ID);

    expect(options.queryKey).toEqual(["runs", FIXTURE_RUN_ID, "events"]);
    expect(options).toMatchObject({ gcTime: 0, staleTime: 0, retry: false });
  });
});

describe("createRunEventsResync", () => {
  it("applies every event after afterSeq in order and reports the new head", async () => {
    const run = createRun(4);
    const applied: number[] = [];
    const resync = createRunEventsResync(run.id);

    const result = await resync({
      afterSeq: 2,
      reason: "gap_too_large",
      minSeq: 3,
      signal: new AbortController().signal,
      apply: (event) => applied.push(event.seq ?? -1),
    });

    expect(applied).toEqual([3, 4, 5]);
    expect(result).toEqual({ headSeq: 5 });
  });
});
