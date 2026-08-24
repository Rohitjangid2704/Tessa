import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseStreamMessage, type KnownStreamEvent } from "@/features/streams/events";
import { FIXTURE_RUN_ID, knownEnvelope, tickEnvelope } from "@/tests/utils/stream-fixtures";
import type { RunEventsPage } from "./run-event-pages";
import { RunEventStore, STREAM_EVENT_LIMIT, type PersistedRunEvent } from "./run-event-store";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function known(wire: Parameters<typeof parseStreamMessage>[0]): KnownStreamEvent {
  const parsed = parseStreamMessage(wire);
  if (parsed.kind !== "known") {
    throw new Error("fixture is not a known event");
  }
  return parsed.event;
}

function persisted(seq: number): PersistedRunEvent {
  return { ...known(tickEnvelope(seq)), seq };
}

function page(seqs: number[], overrides: Partial<RunEventsPage> = {}): RunEventsPage {
  const highest = Math.max(0, ...seqs);
  return {
    events: seqs.map((seq) => known(tickEnvelope(seq))),
    lowestSeq: seqs.length === 0 ? null : Math.min(...seqs),
    highestSeq: highest,
    headSeq: highest,
    hasMore: false,
    skipped: 0,
    ...overrides,
  };
}

function seqsOf(store: RunEventStore): Array<number | null> {
  return store.getSnapshot().events.map((event) => event.seq);
}

describe("RunEventStore seq rule", () => {
  it("starts empty, unloaded and at seq 0", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);

    expect(store.getSnapshot()).toMatchObject({
      events: [],
      loaded: false,
      finished: false,
      lastSeq: 0,
      lowestSeq: null,
      hasOlder: false,
      gap: null,
    });
  });

  it("applies only the next seq and advances the ledger", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);
    store.load(page([1, 2, 3]));

    expect(store.append(persisted(4))).toEqual({ outcome: "applied" });
    expect(store.append(persisted(5))).toEqual({ outcome: "applied" });

    expect(seqsOf(store)).toEqual([1, 2, 3, 4, 5]);
    expect(store.getLastSeq()).toBe(5);
  });

  it("drops a duplicate and an older seq without touching the log", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);
    store.load(page([1, 2, 3]));

    expect(store.append(persisted(3))).toEqual({ outcome: "duplicate" });
    expect(store.append(persisted(1))).toEqual({ outcome: "duplicate" });

    expect(seqsOf(store)).toEqual([1, 2, 3]);
    expect(store.getSnapshot().gap).toBeNull();
  });

  it("refuses a seq that skips ahead and records the gap for a reconnect", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);
    store.load(page([1, 2]));

    expect(store.append(persisted(5))).toEqual({ outcome: "gap", expected: 3, received: 5 });

    expect(seqsOf(store)).toEqual([1, 2]);
    expect(store.getLastSeq()).toBe(2);
    expect(store.getSnapshot().gap).toEqual({ expected: 3, received: 5 });
  });

  it("clears the gap once the missing seq arrives or the caller clears it", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);
    store.load(page([1]));
    store.append(persisted(4));
    expect(store.getSnapshot().gap).not.toBeNull();

    store.clearGap();
    expect(store.getSnapshot().gap).toBeNull();

    store.append(persisted(4));
    store.append(persisted(2));
    expect(store.getSnapshot().gap).toBeNull();
    expect(seqsOf(store)).toEqual([1, 2]);
  });

  it("counts events the socket could not decode as consumed seqs, in order", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);
    store.load(page([1]));

    expect(store.skip(2)).toEqual({ outcome: "applied" });
    expect(store.append(persisted(3))).toEqual({ outcome: "applied" });
    expect(store.skip(3)).toEqual({ outcome: "duplicate" });
    expect(store.skip(9)).toEqual({ outcome: "gap", expected: 4, received: 9 });

    expect(seqsOf(store)).toEqual([1, 3]);
    expect(store.getSnapshot().skippedCount).toBe(1);
    expect(store.getLastSeq()).toBe(3);
  });

  it("starts a never loaded run at seq 1", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);

    expect(store.append(persisted(2))).toMatchObject({ outcome: "gap", expected: 1 });
    expect(store.append(persisted(1))).toEqual({ outcome: "applied" });
    expect(store.getSnapshot().lowestSeq).toBe(1);
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);
    store.load(page([1]));
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.append(persisted(2));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.append(persisted(3));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("returns the same snapshot object until something changes", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);
    store.load(page([1]));
    const first = store.getSnapshot();

    store.append(persisted(1));
    expect(store.getSnapshot()).toBe(first);

    store.append(persisted(2));
    expect(store.getSnapshot()).not.toBe(first);
  });
});

describe("RunEventStore load and finished", () => {
  it("replaces the log from a page and marks the store loaded", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);

    store.load(page([5, 6, 7], { hasMore: true, skipped: 2 }));

    expect(store.getSnapshot()).toMatchObject({
      loaded: true,
      lastSeq: 7,
      lowestSeq: 5,
      hasOlder: true,
      skippedCount: 2,
    });
    expect(seqsOf(store)).toEqual([5, 6, 7]);
  });

  it("finishes when the page already holds run.finished, or the run is terminal", () => {
    const withFinished = new RunEventStore(FIXTURE_RUN_ID);
    withFinished.load({
      ...page([1]),
      events: [known(tickEnvelope(1)), known(knownEnvelope("run.finished", 2))],
      highestSeq: 2,
    });
    expect(withFinished.getSnapshot().finished).toBe(true);

    const terminal = new RunEventStore(FIXTURE_RUN_ID);
    terminal.load(page([1]), { runTerminal: true });
    expect(terminal.getSnapshot().finished).toBe(true);

    const running = new RunEventStore(FIXTURE_RUN_ID);
    running.load(page([1]), { runTerminal: false });
    expect(running.getSnapshot().finished).toBe(false);
  });

  it("finishes when run.finished arrives live", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);
    store.load(page([1]));

    store.append({ ...known(knownEnvelope("run.finished", 2)), seq: 2 });

    expect(store.getSnapshot().finished).toBe(true);
  });

  it("keeps the debug stream events across a reload and resets the gap", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);
    store.load(page([1]));
    store.recordStreamEvent(known(knownEnvelope("stream.replay_end", null)));
    store.append(persisted(9));
    expect(store.getSnapshot().gap).not.toBeNull();

    store.load(page([1, 2, 3, 4]));

    expect(store.getSnapshot().streamEvents).toHaveLength(1);
    expect(store.getSnapshot().gap).toBeNull();
    expect(store.getLastSeq()).toBe(4);
  });

  it("caps the debug stream events at the limit, newest kept", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID, { streamEventLimit: 3 });
    for (let index = 0; index < 5; index += 1) {
      store.recordStreamEvent(known(knownEnvelope("stream.heartbeat", null)));
    }

    expect(store.getSnapshot().streamEvents).toHaveLength(3);
    expect(STREAM_EVENT_LIMIT).toBe(200);
  });
});

describe("RunEventStore loadOlder", () => {
  it("fetches before the lowest loaded seq, prepends and dedupes", async () => {
    const fetchPage = vi.fn(async () => page([3, 4, 5], { hasMore: true }));
    const store = new RunEventStore(FIXTURE_RUN_ID, { fetchPage });
    store.load(page([5, 6, 7], { hasMore: true }));

    await store.loadOlder();

    expect(fetchPage).toHaveBeenCalledWith(5);
    expect(seqsOf(store)).toEqual([3, 4, 5, 6, 7]);
    expect(store.getSnapshot()).toMatchObject({
      lowestSeq: 3,
      hasOlder: true,
      loadingOlder: false,
      olderError: null,
    });
  });

  it("accepts an explicit before_seq and stops when the server has no older page", async () => {
    const fetchPage = vi.fn(async () => page([1, 2], { hasMore: false }));
    const store = new RunEventStore(FIXTURE_RUN_ID, { fetchPage });
    store.load(page([3, 4], { hasMore: true }));

    await store.loadOlder(3);
    await store.loadOlder();

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().hasOlder).toBe(false);
    expect(seqsOf(store)).toEqual([1, 2, 3, 4]);
  });

  it("reports loading while a request is in flight and ignores a second call", async () => {
    let resolve: (value: RunEventsPage) => void = () => {};
    const fetchPage = vi.fn(
      () =>
        new Promise<RunEventsPage>((done) => {
          resolve = done;
        }),
    );
    const store = new RunEventStore(FIXTURE_RUN_ID, { fetchPage });
    store.load(page([5], { hasMore: true }));

    const first = store.loadOlder();
    const second = store.loadOlder();
    expect(store.getSnapshot().loadingOlder).toBe(true);
    resolve(page([4]));
    await Promise.all([first, second]);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().loadingOlder).toBe(false);
  });

  it("keeps the log and exposes the error when the request fails, then retries", async () => {
    const fetchPage = vi
      .fn<() => Promise<RunEventsPage>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(page([4]));
    const store = new RunEventStore(FIXTURE_RUN_ID, { fetchPage });
    store.load(page([5], { hasMore: true }));

    await store.loadOlder();
    expect(store.getSnapshot().olderError?.message).toBe("boom");
    expect(store.getSnapshot().loadingOlder).toBe(false);
    expect(seqsOf(store)).toEqual([5]);

    await store.loadOlder();
    expect(store.getSnapshot().olderError).toBeNull();
    expect(seqsOf(store)).toEqual([4, 5]);
  });

  it("drops an older page that arrives after the log was reloaded", async () => {
    let resolve: (value: RunEventsPage) => void = () => {};
    const fetchPage = vi.fn(
      () =>
        new Promise<RunEventsPage>((done) => {
          resolve = done;
        }),
    );
    const store = new RunEventStore(FIXTURE_RUN_ID, { fetchPage });
    store.load(page([5, 6], { hasMore: true }));

    const pending = store.loadOlder();
    store.load(page([50, 51], { hasMore: true }));
    resolve(page([3, 4]));
    await pending;

    expect(seqsOf(store)).toEqual([50, 51]);
  });

  it("does nothing without a page fetcher or before anything is loaded", async () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);
    await store.loadOlder();
    store.load(page([5], { hasMore: true }));
    await store.loadOlder();

    expect(seqsOf(store)).toEqual([5]);
  });
});

describe("RunEventStore scheduled invalidations", () => {
  it("runs a scheduled task after the throttle and cancels it on dispose", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID, { throttleMs: 1000 });
    const task = vi.fn();
    const cancelled = vi.fn();

    store.scheduleInvalidation("a", task);
    store.scheduleInvalidation("b", cancelled);
    vi.advanceTimersByTime(999);
    expect(task).not.toHaveBeenCalled();
    store.dispose();
    vi.advanceTimersByTime(5000);

    expect(task).not.toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("flushes pending tasks immediately", () => {
    const store = new RunEventStore(FIXTURE_RUN_ID);
    const task = vi.fn();
    store.scheduleInvalidation("a", task);

    store.flushScheduled();

    expect(task).toHaveBeenCalledTimes(1);
  });
});
