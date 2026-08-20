import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import {
  BACKOFF_SCHEDULE_MS,
  MAX_BACKOFF_MS,
  SILENCE_TIMEOUT_MS,
  backoffDelayMs,
} from "@/lib/backoff";
import { createSocketHarness, type SocketHarness } from "@/tests/utils/fake-socket";
import {
  FIXTURE_RUN_ID,
  envelope,
  heartbeatEnvelope,
  helloEnvelope,
  knownEnvelope,
  replayEndEnvelope,
  tickEnvelope,
} from "@/tests/utils/stream-fixtures";
import { CLOSE_CODES, appendLastSeq, decideOnClose } from "./socket";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function startLive(harness: SocketHarness, resumedFrom: number | null = null) {
  harness.socket.connect();
  await settle();
  harness.latest.open();
  harness.latest.receive(helloEnvelope(resumedFrom, resumedFrom ?? 0));
  return harness.latest;
}

async function startHealthy(harness: SocketHarness, throughSeq = 0) {
  const transport = await startLive(harness, throughSeq === 0 ? null : throughSeq);
  transport.receive(replayEndEnvelope(throughSeq));
  return transport;
}

describe("backoffDelayMs", () => {
  it("follows 1, 2, 5, 10, 30 seconds and caps at 30 seconds without jitter", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 20].map((attempt) => backoffDelayMs(attempt, () => 0.5));
    expect(delays).toEqual([1000, 2000, 5000, 10_000, 30_000, 30_000, 30_000, 30_000]);
    expect(BACKOFF_SCHEDULE_MS).toEqual([1000, 2000, 5000, 10_000, 30_000]);
    expect(SILENCE_TIMEOUT_MS).toBe(45_000);
  });

  it("spreads each delay by 20 percent and never exceeds the cap", () => {
    const low = [1, 2, 3, 4, 5].map((attempt) => backoffDelayMs(attempt, () => 0));
    const high = [1, 2, 3, 4, 5].map((attempt) => backoffDelayMs(attempt, () => 1));
    expect(low).toEqual([800, 1600, 4000, 8000, 24_000]);
    expect(high).toEqual([1200, 2400, 6000, 12_000, MAX_BACKOFF_MS]);
  });

  it("treats attempts below one as the first step", () => {
    expect(backoffDelayMs(0, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(-3, () => 0.5)).toBe(1000);
  });

  it("uses Math.random by default and stays inside the jitter band", () => {
    for (let index = 0; index < 50; index += 1) {
      const delay = backoffDelayMs(2);
      expect(delay).toBeGreaterThanOrEqual(1600);
      expect(delay).toBeLessThanOrEqual(2400);
    }
  });
});

describe("close code table", () => {
  it.each([
    [1000, "stop", "closed"],
    [4400, "stop", "failed"],
    [4401, "refresh_then_retry", null],
    [4403, "stop", "failed"],
    [4404, "stop", "failed"],
    [4408, "retry", null],
    [4413, "retry", null],
    [4429, "retry", null],
    [1001, "retry", null],
    [1006, "retry", null],
    [1011, "retry", null],
    [1013, "retry", null],
  ])("decides %i as %s", (code, action, terminal) => {
    expect(decideOnClose(code)).toMatchObject({ action, terminal });
  });

  it("explains every close that is not silent", () => {
    for (const code of [4400, 4401, 4403, 4404, 4408, 4413, 4429, 1006]) {
      expect(decideOnClose(code).message).toEqual(expect.any(String));
    }
    expect(decideOnClose(1000).message).toBeNull();
  });

  it.each([1000, 4400, 4403, 4404])("does not reconnect after %i", async (code) => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.serverClose(code);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(harness.requestTicket).toHaveBeenCalledTimes(1);
    expect(harness.transports).toHaveLength(1);
    expect(harness.socket.getState().status).toBe(code === 1000 ? "closed" : "failed");
    expect(harness.socket.getState().closeCode).toBe(code);
  });

  it.each([4408, 4413, 4429, 1006, 1011])("resumes after %i", async (code) => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.receive(tickEnvelope(1));
    transport.serverClose(code);

    expect(harness.socket.getState()).toMatchObject({ status: "reconnecting", attempt: 1 });
    await vi.advanceTimersByTimeAsync(1000);

    expect(harness.transports).toHaveLength(2);
    expect(harness.latest.lastSeqParam).toBe("1");
  });

  it("shows a visible message for 4429 and clears it once the stream is live again", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.serverClose(CLOSE_CODES.tooManyConnections);

    expect(harness.socket.getState().message).toMatch(/too many live streams/i);
    expect(harness.socket.getState().closeCode).toBe(4429);

    await vi.advanceTimersByTimeAsync(1000);
    harness.latest.open();
    harness.latest.receive(helloEnvelope(0));

    expect(harness.socket.getState()).toMatchObject({ status: "live", message: null });
  });

  it("refreshes the token once on 4401, then retries immediately", async () => {
    const harness = createSocketHarness();
    const transport = await startLive(harness);
    transport.serverClose(CLOSE_CODES.unauthenticated);
    await settle();

    expect(harness.refreshToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.requestTicket).toHaveBeenCalledTimes(2);
    expect(harness.transports).toHaveLength(2);
  });

  it("fails when 4401 repeats without a healthy stream in between", async () => {
    const harness = createSocketHarness();
    harness.socket.connect();
    await settle();
    harness.latest.serverClose(CLOSE_CODES.unauthenticated);
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    harness.latest.serverClose(CLOSE_CODES.unauthenticated);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(harness.refreshToken).toHaveBeenCalledTimes(1);
    expect(harness.transports).toHaveLength(2);
    expect(harness.socket.getState()).toMatchObject({ status: "failed", closeCode: 4401 });
  });

  it("allows another refresh after a healthy stream", async () => {
    const harness = createSocketHarness();
    const first = await startLive(harness);
    first.serverClose(CLOSE_CODES.unauthenticated);
    await vi.advanceTimersByTimeAsync(0);
    harness.latest.open();
    harness.latest.receive(helloEnvelope(0));
    harness.latest.serverClose(CLOSE_CODES.unauthenticated);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.refreshToken).toHaveBeenCalledTimes(2);
    expect(harness.transports).toHaveLength(3);
  });

  it("fails with a session message when the refresh itself fails", async () => {
    const harness = createSocketHarness({
      refreshToken: async () => {
        throw new Error("session gone");
      },
    });
    const transport = await startLive(harness);
    transport.serverClose(CLOSE_CODES.unauthenticated);
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.socket.getState()).toMatchObject({ status: "failed", closeCode: 4401 });
    expect(harness.socket.getState().message).toMatch(/session/i);
    expect(harness.transports).toHaveLength(1);
  });
});

describe("reconnect policy", () => {
  it("mints a new ticket for every attempt and never reuses a url", async () => {
    const harness = createSocketHarness();
    harness.socket.connect();
    await settle();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      harness.latest.serverClose(1006);
      await vi.advanceTimersByTimeAsync(30_000);
    }

    expect(harness.requestTicket).toHaveBeenCalledTimes(4);
    expect(harness.transports).toHaveLength(4);
    expect(new Set(harness.transports.map((transport) => transport.ticket)).size).toBe(4);
    for (const call of harness.requestTicket.mock.calls) {
      expect(call[0]).toBe(FIXTURE_RUN_ID);
    }
  });

  it("backs off 1, 2, 5, 10, 30, 30 seconds while attempts keep failing", async () => {
    const harness = createSocketHarness();
    harness.socket.connect();
    await settle();

    const observed: Array<number | null> = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      harness.latest.serverClose(1006);
      const state = harness.socket.getState();
      observed.push(state.nextRetryInMs);
      expect(state).toMatchObject({ status: "reconnecting", attempt });
      await vi.advanceTimersByTimeAsync(state.nextRetryInMs ?? 0);
    }

    expect(observed).toEqual([1000, 2000, 5000, 10_000, 30_000, 30_000]);
    expect(harness.transports).toHaveLength(7);
  });

  it("does not open the next attempt before the delay has passed", async () => {
    const harness = createSocketHarness();
    harness.socket.connect();
    await settle();
    harness.latest.serverClose(1006);

    await vi.advanceTimersByTimeAsync(999);
    expect(harness.transports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.transports).toHaveLength(2);
  });

  it("resets the backoff after the replay of a healthy stream finished", async () => {
    const harness = createSocketHarness();
    harness.socket.connect();
    await settle();
    harness.latest.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    harness.latest.serverClose(1006);
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.socket.getState().attempt).toBe(2);

    harness.latest.open();
    harness.latest.receive(helloEnvelope());
    expect(harness.socket.getState().attempt).toBe(2);
    harness.latest.receive(replayEndEnvelope(0));
    expect(harness.socket.getState()).toMatchObject({ attempt: 0, status: "live" });

    harness.latest.serverClose(1006);
    expect(harness.socket.getState()).toMatchObject({ attempt: 1, nextRetryInMs: 1000 });
  });

  it("exposes the retry deadline for countdowns", async () => {
    const harness = createSocketHarness();
    await startHealthy(harness);
    const before = Date.now();
    harness.latest.serverClose(1006);

    const state = harness.socket.getState();
    expect(state.nextRetryAt).toBe(before + 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.socket.getState()).toMatchObject({ nextRetryInMs: null, nextRetryAt: null });
  });

  it("applies jitter from the injected random source", async () => {
    const harness = createSocketHarness({ random: () => 1 });
    harness.socket.connect();
    await settle();
    harness.latest.serverClose(1006);

    expect(harness.socket.getState().nextRetryInMs).toBe(1200);
  });

  it("resumes with last_seq equal to the highest applied seq", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.receiveAll([
      knownEnvelope("run.created", 1),
      knownEnvelope("run.status_changed", 2),
      tickEnvelope(3),
    ]);
    transport.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);

    expect(harness.transports[0]?.lastSeqParam).toBeNull();
    expect(harness.latest.lastSeqParam).toBe("3");
    expect(harness.socket.getState().lastSeq).toBe(3);
  });

  it("starts from the supplied initial last_seq", async () => {
    const harness = createSocketHarness({ initialLastSeq: 7 });
    harness.socket.connect();
    await settle();

    expect(harness.latest.lastSeqParam).toBe("7");
    expect(harness.socket.getState().lastSeq).toBe(7);
  });

  it("keeps an existing ticket and replaces a stale last_seq in the url", () => {
    expect(appendLastSeq("ws://h/ws/v1/runs/r?ticket=t", 4)).toBe(
      "ws://h/ws/v1/runs/r?ticket=t&last_seq=4",
    );
    expect(appendLastSeq("ws://h/ws/v1/runs/r?ticket=t&last_seq=1", 4)).toBe(
      "ws://h/ws/v1/runs/r?ticket=t&last_seq=4",
    );
    expect(appendLastSeq("ws://h/ws/v1/runs/r?ticket=t&last_seq=1", 0)).toBe(
      "ws://h/ws/v1/runs/r?ticket=t",
    );
  });

  it("records the resumed_from of the latest hello and the limits", async () => {
    const harness = createSocketHarness();
    const transport = await startLive(harness, 5);

    expect(transport).toBeDefined();
    expect(harness.socket.getState()).toMatchObject({
      status: "live",
      resumedFrom: 5,
      limits: { max_tiles: 12 },
    });
  });
});

describe("ticket failures", () => {
  function failingTicket(error: unknown) {
    return vi.fn(async () => {
      throw error;
    });
  }

  it("stops without retry when the run does not exist", async () => {
    const notFound = new ApiError({ status: 404, code: "not_found", message: "Run not found" });
    const harness = createSocketHarness({ requestTicket: failingTicket(notFound) });
    harness.socket.connect();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(harness.requestTicket).toHaveBeenCalledTimes(1);
    expect(harness.socket.getState()).toMatchObject({
      status: "failed",
      message: "This run was not found",
    });
  });

  it.each([401, 403])("stops without retry on a %i from the ticket endpoint", async (status) => {
    const error = new ApiError({ status, code: "forbidden", message: "no" });
    const harness = createSocketHarness({ requestTicket: failingTicket(error) });
    harness.socket.connect();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(harness.requestTicket).toHaveBeenCalledTimes(1);
    expect(harness.socket.getState().status).toBe("failed");
  });

  it("retries on a 503 and on a network failure with the usual backoff", async () => {
    const unavailable = new ApiError({
      status: 503,
      code: "dependency_unavailable",
      message: "down",
    });
    const calls: unknown[] = [unavailable, ApiError.network(new Error("offline"))];
    const harness = createSocketHarness({
      requestTicket: vi.fn(async (runId: string) => {
        const next = calls.shift();
        if (next !== undefined) {
          throw next;
        }
        return { ws_url: `ws://mock.test/ws/v1/runs/${runId}?ticket=ok` };
      }),
    });
    harness.socket.connect();
    await settle();
    expect(harness.socket.getState()).toMatchObject({
      status: "reconnecting",
      attempt: 1,
      nextRetryInMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.socket.getState()).toMatchObject({ attempt: 2, nextRetryInMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);

    expect(harness.transports).toHaveLength(1);
    expect(harness.latest.ticket).toBe("ok");
  });

  it("waits at least Retry-After on a 429 from the ticket endpoint", async () => {
    const limited = new ApiError({
      status: 429,
      code: "rate_limited",
      message: "slow down",
      retryAfterSeconds: 20,
    });
    const harness = createSocketHarness({ requestTicket: failingTicket(limited) });
    harness.socket.connect();
    await settle();

    expect(harness.socket.getState().nextRetryInMs).toBe(20_000);
  });

  it("retries on an unexpected error type", async () => {
    const harness = createSocketHarness({ requestTicket: failingTicket(new TypeError("x")) });
    harness.socket.connect();
    await settle();

    expect(harness.socket.getState()).toMatchObject({ status: "reconnecting", attempt: 1 });
  });

  it("retries when the transport factory throws", async () => {
    const harness = createSocketHarness({
      webSocketFactory: () => {
        throw new Error("blocked");
      },
    });
    harness.socket.connect();
    await settle();

    expect(harness.socket.getState()).toMatchObject({ status: "reconnecting", attempt: 1 });
  });
});

describe("silence watchdog", () => {
  it("treats 45 seconds of silence as dead and reconnects", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.receive(tickEnvelope(1));

    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS - 1);
    expect(harness.socket.getState().status).toBe("live");
    expect(harness.transports).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.socket.getState()).toMatchObject({ status: "reconnecting", attempt: 1 });
    expect(transport.closedByClient).not.toBeNull();
    expect(harness.socket.getState().message).toMatch(/silent/i);

    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.transports).toHaveLength(2);
    expect(harness.latest.lastSeqParam).toBe("1");
  });

  it("is kept alive by heartbeats every 15 seconds", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);

    for (let beat = 0; beat < 12; beat += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      transport.receive(heartbeatEnvelope());
    }

    expect(harness.socket.getState().status).toBe("live");
    expect(harness.transports).toHaveLength(1);
  });

  it("counts any message as activity, not only heartbeats", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);

    await vi.advanceTimersByTimeAsync(40_000);
    transport.receive(tickEnvelope(1));
    await vi.advanceTimersByTimeAsync(40_000);

    expect(harness.socket.getState().status).toBe("live");
    await vi.advanceTimersByTimeAsync(5000);
    expect(harness.socket.getState().status).toBe("reconnecting");
  });

  it("reaps a connection that opens and never sends stream.hello", async () => {
    const harness = createSocketHarness();
    harness.socket.connect();
    await settle();
    harness.latest.open();

    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS);

    expect(harness.socket.getState().status).toBe("reconnecting");
    expect(harness.transports[0]?.closedByClient).not.toBeNull();
  });

  it("honours a shorter silence timeout", async () => {
    const harness = createSocketHarness({ silenceTimeoutMs: 1000 });
    await startHealthy(harness);

    await vi.advanceTimersByTimeAsync(1000);

    expect(harness.socket.getState().status).toBe("reconnecting");
  });

  it("ignores everything the abandoned connection still sends", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS);
    const before = harness.events.length;

    transport.receive(tickEnvelope(1));
    transport.serverClose(4404);

    expect(harness.events).toHaveLength(before);
    expect(harness.socket.getState().status).toBe("reconnecting");
  });
});

describe("sequence handling", () => {
  it("delivers events in order and tracks the highest applied seq", async () => {
    const harness = createSocketHarness();
    const transport = await startLive(harness);
    transport.receiveAll([
      knownEnvelope("run.created", 1),
      knownEnvelope("run.status_changed", 2),
      tickEnvelope(3),
      replayEndEnvelope(3),
      heartbeatEnvelope(),
      tickEnvelope(4),
    ]);

    expect(harness.eventSeqs).toEqual([null, 1, 2, 3, null, null, 4]);
    expect(harness.socket.getState().lastSeq).toBe(4);
  });

  it("reconnects from the last good seq when a seq is skipped", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.receiveAll([tickEnvelope(1), tickEnvelope(2), tickEnvelope(4)]);

    expect(harness.eventSeqs.filter((seq) => seq !== null)).toEqual([1, 2]);
    expect(harness.socket.getState()).toMatchObject({
      status: "reconnecting",
      lastSeq: 2,
      gapCount: 1,
    });
    expect(transport.closedByClient).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.latest.lastSeqParam).toBe("2");
    harness.latest.open();
    harness.latest.receiveAll([
      helloEnvelope(2),
      tickEnvelope(3),
      tickEnvelope(4),
      replayEndEnvelope(4),
    ]);

    expect(harness.eventSeqs.filter((seq) => seq !== null)).toEqual([1, 2, 3, 4]);
    expect(harness.socket.getState().lastSeq).toBe(4);
  });

  it("detects a gap at the start of a resumed replay", async () => {
    const harness = createSocketHarness({ initialLastSeq: 2 });
    harness.socket.connect();
    await settle();
    harness.latest.open();
    harness.latest.receive(tickEnvelope(5));

    expect(harness.events).toHaveLength(0);
    expect(harness.socket.getState()).toMatchObject({ status: "reconnecting", lastSeq: 2 });
  });

  it("drops duplicates silently and counts them", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.receiveAll([tickEnvelope(1), tickEnvelope(2), tickEnvelope(2), tickEnvelope(1)]);

    expect(harness.eventSeqs.filter((seq) => seq !== null)).toEqual([1, 2]);
    expect(harness.socket.getState()).toMatchObject({
      status: "live",
      lastSeq: 2,
      duplicateEventCount: 2,
    });
  });

  it("ignores replayed events at or below the supplied initial last_seq", async () => {
    const harness = createSocketHarness({ initialLastSeq: 3 });
    harness.socket.connect();
    await settle();
    harness.latest.open();
    harness.latest.receiveAll([tickEnvelope(2), tickEnvelope(3), tickEnvelope(4)]);

    expect(harness.eventSeqs).toEqual([4]);
  });

  it("ignores unknown types, counts them and still advances the seq", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.receiveAll([
      tickEnvelope(1),
      envelope("finding.created", 2, { whatever: true }),
      envelope("tile.nope", null),
      tickEnvelope(3),
    ]);

    expect(harness.eventSeqs.filter((seq) => seq !== null)).toEqual([1, 3]);
    expect(harness.socket.getState()).toMatchObject({
      status: "live",
      lastSeq: 3,
      unknownEventCount: 2,
      gapCount: 0,
    });
  });

  it("counts invalid and binary messages without delivering them", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    const delivered = harness.events.length;
    transport.receive("{not json");
    transport.receive(new ArrayBuffer(4));
    transport.receive(envelope("hello.tick", 1, { n: "bad" }));
    transport.receive(
      envelope("hello.tick", 2, {}, { run_id: "00000000-0000-0000-0000-000000000000" }),
    );

    expect(harness.events).toHaveLength(delivered);
    expect(harness.socket.getState().invalidMessageCount).toBe(4);
  });

  it("applies the seq of an invalid persisted event so the next one is not a gap", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.receive(envelope("hello.tick", 1, { n: "bad" }));
    transport.receive(tickEnvelope(2));

    expect(harness.socket.getState()).toMatchObject({ status: "live", lastSeq: 2, gapCount: 0 });
    expect(harness.eventSeqs.filter((seq) => seq !== null)).toEqual([2]);
  });

  it("does not run gap logic on ephemeral events", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.receiveAll([tickEnvelope(1), heartbeatEnvelope(), heartbeatEnvelope()]);

    expect(harness.socket.getState()).toMatchObject({ lastSeq: 1, gapCount: 0 });
  });

  it("keeps running when an event listener throws", async () => {
    const harness = createSocketHarness();
    const thrown: unknown[] = [];
    const queue = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      try {
        callback();
      } catch (error) {
        thrown.push(error);
      }
    });
    harness.socket.setListeners({
      onEvent: () => {
        throw new Error("listener bug");
      },
    });
    const transport = await startHealthy(harness);
    transport.receiveAll([tickEnvelope(1), tickEnvelope(2)]);
    queue.mockRestore();

    expect(harness.socket.getState()).toMatchObject({ status: "live", lastSeq: 2 });
    expect(thrown.length).toBeGreaterThanOrEqual(2);
  });
});

describe("stream control events", () => {
  it("records a closing reason and a stream error message", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);

    transport.receive(knownEnvelope("stream.error", null, { message: "queue overflow" }));
    expect(harness.socket.getState().message).toBe("queue overflow");

    transport.receive(knownEnvelope("stream.closing", null, { reason: "slow_consumer" }));
    expect(harness.socket.getState().message).toMatch(/slow_consumer/);
  });

  it("refetches missed events on stream.resync_required, then reconnects from the head", async () => {
    const harness = createSocketHarness({
      resync: async ({ apply }) => {
        apply({
          type: "hello.tick",
          run_id: FIXTURE_RUN_ID,
          seq: 4,
          ts: "2026-09-30T14:03:22.123Z",
          payload: { n: 4, total: 6, message: "refetched" },
        });
        return { headSeq: 9 };
      },
    });
    const transport = await startHealthy(harness);
    transport.receiveAll([tickEnvelope(1), tickEnvelope(2), tickEnvelope(3)]);
    transport.receive(
      knownEnvelope("stream.resync_required", null, { reason: "gap_too_large", min_seq: 8 }),
    );

    expect(harness.socket.getState()).toMatchObject({ status: "resyncing" });
    expect(transport.closedByClient).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.resync).toHaveBeenCalledTimes(1);
    expect(harness.resync.mock.calls[0]?.[0]).toMatchObject({
      afterSeq: 3,
      reason: "gap_too_large",
      minSeq: 8,
    });
    expect(harness.eventSeqs.filter((seq) => seq !== null)).toEqual([1, 2, 3, 4]);
    expect(harness.socket.getState()).toMatchObject({ status: "reconnecting", lastSeq: 9 });

    await vi.advanceTimersByTimeAsync(0);
    expect(harness.transports).toHaveLength(2);
    expect(harness.latest.lastSeqParam).toBe("9");
  });

  it("retries with backoff when the resync fetch fails", async () => {
    const harness = createSocketHarness({
      resync: async () => {
        throw new Error("network");
      },
    });
    const transport = await startHealthy(harness);
    transport.receive(
      knownEnvelope("stream.resync_required", null, { reason: "retention", min_seq: 100 }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.socket.getState()).toMatchObject({ status: "reconnecting", attempt: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.transports).toHaveLength(2);
  });

  it("fails clearly when the server needs a resync and no resync is configured", async () => {
    const harness = createSocketHarness({}, { withoutResync: true });
    const transport = await startHealthy(harness);
    transport.receive(
      knownEnvelope("stream.resync_required", null, { reason: "retention", min_seq: 100 }),
    );
    await vi.advanceTimersByTimeAsync(120_000);

    expect(harness.socket.getState().status).toBe("failed");
    expect(harness.socket.getState().message).toMatch(/resync/i);
    expect(harness.transports).toHaveLength(1);
  });

  it("ignores the close that follows a resync request", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.receive(
      knownEnvelope("stream.resync_required", null, { reason: "gap_too_large", min_seq: 8 }),
    );
    transport.serverClose(1000, "resync_required");
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.socket.getState().status).not.toBe("closed");
    expect(harness.resync).toHaveBeenCalledTimes(1);
  });
});

describe("lifecycle", () => {
  it("close() stops reconnecting and closes the transport normally", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    harness.socket.close();

    expect(transport.closedByClient?.code).toBe(1000);
    expect(harness.socket.getState().status).toBe("closed");
    transport.serverClose(1006);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.transports).toHaveLength(1);
  });

  it("close() cancels a scheduled retry", async () => {
    const harness = createSocketHarness();
    await startHealthy(harness);
    harness.latest.serverClose(1006);
    harness.socket.close();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(harness.transports).toHaveLength(1);
    expect(harness.socket.getState()).toMatchObject({ status: "closed", nextRetryInMs: null });
  });

  it("close() while the ticket is in flight never opens a transport", async () => {
    let resolveTicket: (ticket: { ws_url: string }) => void = () => {};
    const harness = createSocketHarness({
      requestTicket: () =>
        new Promise((resolve) => {
          resolveTicket = resolve;
        }),
    });
    harness.socket.connect();
    harness.socket.close();
    resolveTicket({ ws_url: "ws://mock.test/ws/v1/runs/x?ticket=late" });
    await settle();

    expect(harness.transports).toHaveLength(0);
    expect(harness.socket.getState().status).toBe("closed");
  });

  it("survives connect, close, connect (a StrictMode double mount) with one ticket and one transport", async () => {
    const harness = createSocketHarness();
    harness.socket.connect();
    harness.socket.close();
    harness.socket.connect();
    await settle();

    expect(harness.requestTicket).toHaveBeenCalledTimes(1);
    expect(harness.transports).toHaveLength(1);
    harness.latest.open();
    harness.latest.receive(helloEnvelope());
    expect(harness.socket.getState().status).toBe("live");
  });

  it("connect() is idempotent while running", async () => {
    const harness = createSocketHarness();
    harness.socket.connect();
    harness.socket.connect();
    await settle();

    expect(harness.requestTicket).toHaveBeenCalledTimes(1);
  });

  it("can restart after a failure and keeps the last seq", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.receive(tickEnvelope(1));
    transport.serverClose(4403);
    expect(harness.socket.getState().status).toBe("failed");

    harness.socket.connect();
    await settle();

    expect(harness.socket.getState().status).toBe("connecting");
    expect(harness.latest.lastSeqParam).toBe("1");
  });

  it("send() writes json only while the transport is open", async () => {
    const harness = createSocketHarness();
    const message = {
      type: "tile.ack" as const,
      payload: { browser_session_id: "0198f6f2-8a11-7c33-8e02-19d0a5a7c9b4", frame_seq: 3 },
    };
    expect(harness.socket.send(message)).toBe(false);

    harness.socket.connect();
    await settle();
    expect(harness.socket.send(message)).toBe(false);
    harness.latest.open();
    expect(harness.socket.send(message)).toBe(true);
    expect(harness.latest.sentMessages).toEqual([message]);

    harness.socket.close();
    expect(harness.socket.send(message)).toBe(false);
  });

  it("notifies subscribers on every state change and stops after unsubscribe", async () => {
    const harness = createSocketHarness();
    const listener = vi.fn();
    const unsubscribe = harness.socket.subscribe(listener);
    harness.socket.connect();
    await settle();
    harness.latest.open();
    harness.latest.receive(helloEnvelope());

    expect(listener).toHaveBeenCalled();
    const calls = listener.mock.calls.length;
    unsubscribe();
    harness.latest.receive(tickEnvelope(1));
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it("reports handler timing for every text message", async () => {
    const samples: Array<{ durationMs: number; bytes: number }> = [];
    const harness = createSocketHarness({ onMessageHandled: (sample) => samples.push(sample) });
    const transport = await startHealthy(harness);
    transport.receive(tickEnvelope(1));

    expect(samples).toHaveLength(3);
    for (const sample of samples) {
      expect(sample.durationMs).toBeGreaterThanOrEqual(0);
      expect(sample.bytes).toBeGreaterThan(10);
    }
  });
});

describe("caller driven reconnect and skipped events", () => {
  it("reconnects from the lowest last seq the caller trusts and replays from there", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.receive(tickEnvelope(1));
    transport.receive(tickEnvelope(2));
    transport.receive(tickEnvelope(3));

    expect(harness.socket.reconnect({ lastSeq: 1, message: "A view fell behind" })).toBe(true);
    expect(harness.socket.getState()).toMatchObject({
      status: "reconnecting",
      lastSeq: 1,
      message: "A view fell behind",
    });
    expect(transport.closedByClient?.code).toBe(1000);

    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.transports).toHaveLength(2);
    expect(harness.latest.lastSeqParam).toBe("1");
    expect(harness.requestTicket).toHaveBeenCalledTimes(2);
  });

  it("never moves last seq forward on a reconnect request", async () => {
    const harness = createSocketHarness();
    const transport = await startHealthy(harness);
    transport.receive(tickEnvelope(1));

    harness.socket.reconnect({ lastSeq: 40, message: "x" });

    expect(harness.socket.getState().lastSeq).toBe(1);
  });

  it("refuses to reconnect when stopped or while a resync is running", async () => {
    const stopped = createSocketHarness();
    expect(stopped.socket.reconnect({ lastSeq: 0, message: "x" })).toBe(false);

    const harness = createSocketHarness({ resync: () => new Promise(() => {}) });
    const transport = await startHealthy(harness);
    transport.receive(knownEnvelope("stream.resync_required", null, { min_seq: 5 }));
    expect(harness.socket.getState().status).toBe("resyncing");

    expect(harness.socket.reconnect({ lastSeq: 0, message: "x" })).toBe(false);
    expect(harness.socket.getState().status).toBe("resyncing");
  });

  it("reports sequence numbers consumed by events it could not deliver", async () => {
    const skipped: number[] = [];
    const harness = createSocketHarness();
    harness.socket.setListeners({
      onEvent: (event) => harness.events.push(event),
      onSkipped: (seq) => skipped.push(seq),
    });
    const transport = await startHealthy(harness);
    transport.receive(tickEnvelope(1));
    transport.receive(envelope("future.thing", 2, { anything: true }));
    transport.receive(knownEnvelope("hello.tick", 3, { n: -1 }));
    transport.receive(tickEnvelope(4));

    expect(skipped).toEqual([2, 3]);
    expect(harness.eventSeqs.filter((seq) => seq !== null)).toEqual([1, 4]);
    expect(harness.socket.getState().lastSeq).toBe(4);
  });

  it("does not report a duplicate or a gap as skipped", async () => {
    const skipped: number[] = [];
    const harness = createSocketHarness();
    harness.socket.setListeners({ onSkipped: (seq) => skipped.push(seq) });
    const transport = await startHealthy(harness);
    transport.receive(envelope("future.thing", 1, {}));
    transport.receive(envelope("future.thing", 1, {}));
    transport.receive(envelope("future.thing", 5, {}));

    expect(skipped).toEqual([1]);
  });
});
