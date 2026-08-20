import { QueryClient, QueryObserver, focusManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";
import {
  ORACLE_POLLING_PROFILE,
  ORACLE_SETTLED_STATUSES,
  RUN_POLLING_PROFILE,
  RUN_TERMINAL_STATUSES,
  createRefetchInterval,
  isOracleSettled,
  isRunTerminal,
  polling,
  type PollableQuery,
  type RefetchInterval,
} from "./polling";

const NON_TERMINAL_RUN_STATUSES = ["queued", "planning", "seeding", "running", "canceling"];

function queryWith(data: unknown, error: unknown = null): PollableQuery {
  return { state: { data, error } };
}

function clock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (delta: number) => {
      current += delta;
    },
  };
}

type Clock = ReturnType<typeof clock>;

function pollFor(
  interval: RefetchInterval,
  query: PollableQuery,
  time: Clock,
  durationMs: number,
): number[] {
  const end = time.now() + durationMs;
  const intervals: number[] = [];
  for (;;) {
    const next = interval(query);
    if (next === false) {
      break;
    }
    intervals.push(next);
    if (time.now() + next > end) {
      break;
    }
    time.advance(next);
  }
  return intervals;
}

describe("status predicates", () => {
  it("lists the terminal run statuses of the contract", () => {
    expect([...RUN_TERMINAL_STATUSES]).toEqual([
      "completed",
      "failed",
      "canceled",
      "budget_exceeded",
    ]);
    expect([...ORACLE_SETTLED_STATUSES]).toEqual(["ok", "error"]);
  });

  it.each(RUN_TERMINAL_STATUSES)("treats run status %s as terminal", (status) => {
    expect(isRunTerminal({ status })).toBe(true);
  });

  it.each(NON_TERMINAL_RUN_STATUSES)("keeps polling a run in status %s", (status) => {
    expect(isRunTerminal({ status })).toBe(false);
  });

  it("is not fooled by data without a status", () => {
    for (const data of [undefined, null, "completed", 7, {}, { status: 3 }, { status: null }]) {
      expect(isRunTerminal(data)).toBe(false);
      expect(isOracleSettled(data)).toBe(false);
    }
  });

  it("settles an oracle result on ok and error only", () => {
    expect(isOracleSettled({ status: "ok" })).toBe(true);
    expect(isOracleSettled({ status: "error" })).toBe(true);
    expect(isOracleSettled({ status: "pending" })).toBe(false);
  });
});

describe("run profile", () => {
  it("polls every second for 30 seconds and every 5 seconds after that", () => {
    const time = clock();
    const interval = createRefetchInterval(RUN_POLLING_PROFILE, time.now);

    const intervals = pollFor(interval, queryWith({ status: "running" }), time, 90_000);

    expect(intervals.slice(0, 30).every((value) => value === 1000)).toBe(true);
    expect(intervals.slice(30).length).toBeGreaterThan(10);
    expect(intervals.slice(30).every((value) => value === 5000)).toBe(true);
  });

  it("starts with the fast interval while there is no data yet", () => {
    const interval = createRefetchInterval(RUN_POLLING_PROFILE, clock().now);

    expect(interval(queryWith(undefined))).toBe(1000);
  });

  it.each(RUN_TERMINAL_STATUSES)("stops on %s", (status) => {
    const interval = createRefetchInterval(RUN_POLLING_PROFILE, clock().now);

    expect(interval(queryWith({ status }))).toBe(false);
  });

  it.each(NON_TERMINAL_RUN_STATUSES)("keeps going on %s", (status) => {
    const interval = createRefetchInterval(RUN_POLLING_PROFILE, clock().now);

    expect(interval(queryWith({ status }))).toBe(1000);
  });

  it("tracks every query on its own clock", () => {
    const time = clock();
    const interval = createRefetchInterval(RUN_POLLING_PROFILE, time.now);
    const older = queryWith({ status: "running" });
    const newer = queryWith({ status: "running" });

    pollFor(interval, older, time, 29_000);
    time.advance(2000);

    expect(interval(newer)).toBe(1000);
    expect(interval(older)).toBe(5000);
  });

  it("goes back to the fast interval after the polling was paused for a while", () => {
    const time = clock();
    const interval = createRefetchInterval(RUN_POLLING_PROFILE, time.now);
    const query = queryWith({ status: "running" });
    pollFor(interval, query, time, 40_000);

    time.advance(15_000);
    expect(interval(query)).toBe(5000);

    time.advance(16_000);
    expect(interval(query)).toBe(1000);
    time.advance(1000);
    expect(interval(query)).toBe(1000);
  });

  it("restarts the fast window when a settled query becomes active again", () => {
    const time = clock();
    const interval = createRefetchInterval(RUN_POLLING_PROFILE, time.now);
    const query = queryWith({ status: "running" });
    pollFor(interval, query, time, 40_000);
    expect(interval(query)).toBe(5000);

    query.state.data = { status: "completed" };
    expect(interval(query)).toBe(false);

    query.state.data = { status: "running" };
    time.advance(1000);
    expect(interval(query)).toBe(1000);
  });

  it("stops on a client error and keeps polling through server and network errors", () => {
    const interval = createRefetchInterval(RUN_POLLING_PROFILE, clock().now);
    const notFound = new ApiError({ status: 404, code: "not_found", message: "gone" });
    const forbidden = new ApiError({ status: 403, code: "forbidden", message: "no" });
    const broken = new ApiError({ status: 500, code: "internal_error", message: "boom" });

    expect(interval(queryWith(undefined, notFound))).toBe(false);
    expect(interval(queryWith({ status: "running" }, forbidden))).toBe(false);
    expect(interval(queryWith({ status: "running" }, broken))).toBe(1000);
    expect(interval(queryWith({ status: "running" }, ApiError.network(new Error("x"))))).toBe(1000);
    expect(interval(queryWith({ status: "running" }, new Error("plain")))).toBe(1000);
  });
});

describe("oracle profile", () => {
  it("polls every 500 ms for 10 seconds and every 2 seconds after that", () => {
    const time = clock();
    const interval = createRefetchInterval(ORACLE_POLLING_PROFILE, time.now);

    const intervals = pollFor(interval, queryWith({ status: "pending" }), time, 30_000);

    expect(intervals.slice(0, 20).every((value) => value === 500)).toBe(true);
    expect(intervals.slice(20).length).toBeGreaterThan(5);
    expect(intervals.slice(20).every((value) => value === 2000)).toBe(true);
  });

  it("stops on ok and error", () => {
    const interval = createRefetchInterval(ORACLE_POLLING_PROFILE, clock().now);

    expect(interval(queryWith({ status: "ok" }))).toBe(false);
    expect(interval(queryWith({ status: "error" }))).toBe(false);
  });

  it("does not treat a terminal run status as settled", () => {
    const interval = createRefetchInterval(ORACLE_POLLING_PROFILE, clock().now);

    expect(interval(queryWith({ status: "completed" }))).toBe(500);
  });
});

describe("shared polling options", () => {
  it("exposes the run and oracle profiles with background polling off", () => {
    expect(polling.run.refetchIntervalInBackground).toBe(false);
    expect(polling.oracle.refetchIntervalInBackground).toBe(false);
    expect(polling.run.refetchInterval(queryWith({ status: "completed" }))).toBe(false);
    expect(polling.oracle.refetchInterval(queryWith({ status: "pending" }))).toBe(500);
  });
});

describe("polling through TanStack Query", () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient();
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    client.clear();
    vi.useRealTimers();
  });

  function observe(statuses: string[]) {
    const queryFn = vi.fn(async () => {
      const index = Math.min(queryFn.mock.calls.length - 1, statuses.length - 1);
      return { status: statuses[index] };
    });
    const observer = new QueryObserver(client, {
      queryKey: ["polled"],
      queryFn,
      retry: false,
      ...polling.run,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    return { queryFn, unsubscribe };
  }

  it("refetches every second and stops after the terminal status", async () => {
    const { queryFn, unsubscribe } = observe(["running", "running", "completed"]);

    await vi.advanceTimersByTimeAsync(0);
    expect(queryFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(queryFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(queryFn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(queryFn).toHaveBeenCalledTimes(3);

    unsubscribe();
  });

  it("slows down after 30 seconds on a run that keeps going", async () => {
    const { queryFn, unsubscribe } = observe(["running"]);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(queryFn.mock.calls.length).toBeGreaterThanOrEqual(29);
    await vi.advanceTimersByTimeAsync(2000);
    const afterSlowdown = queryFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(queryFn.mock.calls.length - afterSlowdown).toBeLessThanOrEqual(3);
    expect(queryFn.mock.calls.length - afterSlowdown).toBeGreaterThanOrEqual(1);

    unsubscribe();
  });

  it("does not refetch while the tab is in the background and resumes in the foreground", async () => {
    const { queryFn, unsubscribe } = observe(["running"]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    const beforeHidden = queryFn.mock.calls.length;

    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(queryFn.mock.calls.length).toBe(beforeHidden);

    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(queryFn.mock.calls.length).toBeGreaterThan(beforeHidden);

    unsubscribe();
  });
});
