import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { SILENCE_TIMEOUT_MS } from "@/lib/backoff";
import { createFeedHarness, sseFrame, type FeedHarness } from "@/tests/utils/fake-feed";
import {
  envelope,
  heartbeatEnvelope,
  helloEnvelope,
  tickEnvelope,
} from "@/tests/utils/stream-fixtures";
import { buildFeedUrl } from "./stream";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function startLive(harness: FeedHarness) {
  harness.stream.connect();
  await settle();
  harness.latest.push(sseFrame("stream.hello", helloEnvelope()));
  await settle();
  return harness.latest;
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return Response.json(
    { error: { code: "x", message: "failed", request_id: "r1", details: [] } },
    { status, headers },
  );
}

describe("EventStream request", () => {
  it("asks for text/event-stream with a plain GET and no Last-Event-ID at first", async () => {
    const harness = createFeedHarness();
    harness.stream.connect();
    await settle();

    const { request } = harness.latest;
    expect(request.method).toBe("GET");
    expect(request.url).toBe("http://api.test/api/v1/feeds/runs?kind=hello");
    expect(request.headers.get("accept")).toBe("text/event-stream");
    expect(request.headers.get("last-event-id")).toBeNull();
    expect(harness.stream.getState().status).toBe("connecting");
  });

  it("goes live on stream.hello and delivers every known event in order", async () => {
    const harness = createFeedHarness();
    const connection = await startLive(harness);
    connection.push(sseFrame("hello.tick", tickEnvelope(1)));
    connection.push(sseFrame("hello.tick", tickEnvelope(2)));
    await settle();

    expect(harness.stream.getState()).toMatchObject({ status: "live", helloCount: 1 });
    expect(harness.events.map((event) => event.type)).toEqual([
      "stream.hello",
      "hello.tick",
      "hello.tick",
    ]);
  });

  it("reassembles events split across chunks, including multi byte characters", async () => {
    const harness = createFeedHarness();
    const connection = await startLive(harness);
    const frame = sseFrame(
      "hello.tick",
      envelope("hello.tick", 1, { n: 1, total: 1, message: "café ✓" }),
    );
    const bytes = new TextEncoder().encode(frame);
    for (let index = 0; index < bytes.length; index += 7) {
      connection.pushBytes(bytes.slice(index, index + 7));
      await settle();
    }

    const tick = harness.events.find((event) => event.type === "hello.tick");
    expect(tick?.payload).toMatchObject({ message: "café ✓" });
  });

  it("ignores unknown types and counts them, and counts invalid messages", async () => {
    const harness = createFeedHarness();
    const connection = await startLive(harness);
    connection.push(sseFrame("scenario.changed", envelope("scenario.changed", null)));
    connection.push("event: junk\ndata: {not json\n\n");
    connection.push(sseFrame("hello.tick", envelope("hello.tick", 1, { n: "x" })));
    connection.push("event: empty\n\n");
    await settle();

    expect(harness.stream.getState()).toMatchObject({
      status: "live",
      unknownEventCount: 1,
      invalidMessageCount: 2,
    });
    expect(harness.events.map((event) => event.type)).toEqual(["stream.hello"]);
  });

  it("treats heartbeat events as ordinary known events", async () => {
    const harness = createFeedHarness();
    const connection = await startLive(harness);
    connection.push(sseFrame("stream.heartbeat", heartbeatEnvelope()));
    await settle();

    expect(harness.events.map((event) => event.type)).toEqual(["stream.hello", "stream.heartbeat"]);
  });

  it("calls onHello with reconnect false first and true afterwards", async () => {
    const harness = createFeedHarness();
    const first = await startLive(harness);
    first.end();
    await vi.advanceTimersByTimeAsync(1000);
    harness.latest.push(sseFrame("stream.hello", helloEnvelope()));
    await settle();

    expect(harness.hellos).toEqual([{ reconnect: false }, { reconnect: true }]);
    expect(harness.stream.getState().helloCount).toBe(2);
  });
});

describe("EventStream comment pings", () => {
  it("counts a ': ping' comment as activity and stays connected", async () => {
    const harness = createFeedHarness();
    const connection = await startLive(harness);

    for (let beat = 0; beat < 8; beat += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      connection.push(": ping\n\n");
      await settle();
    }

    expect(harness.stream.getState().status).toBe("live");
    expect(harness.connections).toHaveLength(1);
    expect(harness.events).toHaveLength(1);
  });

  it("treats 45 seconds without any bytes as dead, aborts and reconnects", async () => {
    const harness = createFeedHarness();
    const connection = await startLive(harness);

    await vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS - 1);
    expect(harness.stream.getState().status).toBe("live");

    await vi.advanceTimersByTimeAsync(1);
    expect(connection.aborted).toBe(true);
    expect(harness.stream.getState()).toMatchObject({ status: "reconnecting", attempt: 1 });
    expect(harness.stream.getState().message).toMatch(/silent/i);

    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.connections).toHaveLength(2);
  });

  it("does not let a comment before the deadline be lost to the timer", async () => {
    const harness = createFeedHarness();
    const connection = await startLive(harness);
    await vi.advanceTimersByTimeAsync(44_000);
    connection.push(": ping\n\n");
    await settle();
    await vi.advanceTimersByTimeAsync(44_000);

    expect(harness.stream.getState().status).toBe("live");
  });
});

describe("EventStream backoff and failures", () => {
  it("backs off 1, 2, 5, 10, 30, 30 seconds when connecting keeps failing", async () => {
    const harness = createFeedHarness({
      respond: () => ApiError.network(new Error("offline")),
    });
    harness.stream.connect();
    await settle();

    const delays: Array<number | null> = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const state = harness.stream.getState();
      expect(state).toMatchObject({ status: "reconnecting", attempt });
      delays.push(state.nextRetryInMs);
      await vi.advanceTimersByTimeAsync(state.nextRetryInMs ?? 0);
    }

    expect(delays).toEqual([1000, 2000, 5000, 10_000, 30_000, 30_000]);
    expect(harness.fetchMock).toHaveBeenCalledTimes(7);
  });

  it("resets the backoff after stream.hello", async () => {
    const harness = createFeedHarness({
      respond: (_request, attempt) => (attempt <= 2 ? ApiError.network(new Error("x")) : undefined),
    });
    harness.stream.connect();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.stream.getState().attempt).toBe(2);

    harness.latest.push(sseFrame("stream.hello", helloEnvelope()));
    await settle();
    expect(harness.stream.getState()).toMatchObject({ status: "live", attempt: 0 });

    harness.latest.end();
    await settle();
    expect(harness.stream.getState()).toMatchObject({ attempt: 1, nextRetryInMs: 1000 });
  });

  it("reconnects with backoff when the server ends the stream", async () => {
    const harness = createFeedHarness();
    const connection = await startLive(harness);
    connection.end();
    await settle();

    expect(harness.stream.getState()).toMatchObject({
      status: "reconnecting",
      attempt: 1,
      nextRetryInMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.connections).toHaveLength(2);
  });

  it("reconnects when the body errors", async () => {
    const harness = createFeedHarness();
    const connection = await startLive(harness);
    connection.breakWith(new TypeError("network reset"));
    await settle();

    expect(harness.stream.getState()).toMatchObject({ status: "reconnecting", attempt: 1 });
    expect(harness.stream.getState().message).toMatch(/broke/i);
  });

  it.each([500, 502, 503, 408])("retries after a %i response", async (status) => {
    const harness = createFeedHarness({
      respond: (_request, attempt) => (attempt === 1 ? errorResponse(status) : undefined),
    });
    harness.stream.connect();
    await settle();

    expect(harness.stream.getState()).toMatchObject({ status: "reconnecting", attempt: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.connections).toHaveLength(1);
  });

  it("waits at least Retry-After after a 429", async () => {
    const harness = createFeedHarness({
      respond: () => errorResponse(429, { "Retry-After": "20" }),
    });
    harness.stream.connect();
    await settle();

    expect(harness.stream.getState().nextRetryInMs).toBe(20_000);
  });

  it.each([400, 401, 403, 404])("gives up without retry after a %i response", async (status) => {
    const harness = createFeedHarness({ respond: () => errorResponse(status) });
    harness.stream.connect();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.stream.getState()).toMatchObject({ status: "failed", message: "failed" });
  });

  it("retries a response without a body", async () => {
    const harness = createFeedHarness({
      respond: (_request, attempt) =>
        attempt === 1 ? new Response(null, { status: 200 }) : undefined,
    });
    harness.stream.connect();
    await settle();

    expect(harness.stream.getState()).toMatchObject({ status: "reconnecting", attempt: 1 });
  });
});

describe("EventStream resume", () => {
  it("sends Last-Event-ID from the last id it saw", async () => {
    const harness = createFeedHarness();
    const connection = await startLive(harness);
    connection.push(sseFrame("hello.tick", tickEnvelope(1), "41"));
    connection.push(sseFrame("hello.tick", tickEnvelope(2), "42"));
    await settle();
    connection.end();
    await vi.advanceTimersByTimeAsync(1000);

    expect(harness.stream.getState().lastEventId).toBe("42");
    expect(harness.latest.request.headers.get("last-event-id")).toBe("42");
  });

  it("requests the stream afresh each attempt through the injected fetch", async () => {
    const harness = createFeedHarness();
    const connection = await startLive(harness);
    connection.end();
    await vi.advanceTimersByTimeAsync(1000);
    harness.latest.end();
    await vi.advanceTimersByTimeAsync(2000);

    expect(harness.fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("EventStream lifecycle", () => {
  it("close() aborts the connection and stops reconnecting", async () => {
    const harness = createFeedHarness();
    const connection = await startLive(harness);
    harness.stream.close();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(connection.aborted).toBe(true);
    expect(harness.stream.getState().status).toBe("closed");
    expect(harness.connections).toHaveLength(1);
  });

  it("close() cancels a scheduled retry", async () => {
    const harness = createFeedHarness();
    const connection = await startLive(harness);
    connection.end();
    await settle();
    harness.stream.close();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(harness.connections).toHaveLength(1);
  });

  it("survives connect, close, connect (a StrictMode double mount) with one live connection", async () => {
    const harness = createFeedHarness();
    harness.stream.connect();
    harness.stream.close();
    harness.stream.connect();
    await settle();

    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = harness.connections;
    expect(first?.aborted).toBe(true);
    second?.push(sseFrame("stream.hello", helloEnvelope()));
    await settle();

    expect(harness.stream.getState().status).toBe("live");
    expect(harness.events).toHaveLength(1);
    expect(harness.hellos).toHaveLength(1);
  });

  it("keeps running when a listener throws", async () => {
    const harness = createFeedHarness();
    const thrown: unknown[] = [];
    const queue = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      try {
        callback();
      } catch (error) {
        thrown.push(error);
      }
    });
    harness.stream.setListeners({
      onEvent: () => {
        throw new Error("listener bug");
      },
    });
    const connection = await startLive(harness);
    connection.push(sseFrame("hello.tick", tickEnvelope(1)));
    await settle();
    queue.mockRestore();

    expect(harness.stream.getState().status).toBe("live");
    expect(thrown.length).toBeGreaterThanOrEqual(2);
  });

  it("connect() is idempotent while running", async () => {
    const harness = createFeedHarness();
    harness.stream.connect();
    harness.stream.connect();
    await settle();

    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("buildFeedUrl", () => {
  it("joins the base url, path and defined query values", () => {
    expect(
      buildFeedUrl("/api/v1/feeds/runs", "http://localhost:8000", {
        target_id: "t1",
        kind: undefined,
        run_id: null,
        limit: 5,
        live: true,
      }),
    ).toBe("http://localhost:8000/api/v1/feeds/runs?target_id=t1&limit=5&live=true");
  });
});
