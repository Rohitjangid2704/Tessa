import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeedHarness, sseFrame } from "@/tests/utils/fake-feed";
import { helloEnvelope, tickEnvelope } from "@/tests/utils/stream-fixtures";
import type { KnownStreamEvent } from "@/features/streams/events";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { useEventStream } = await import("./use-event-stream");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useEventStream", () => {
  it("builds the feed url from the path, base url and query and connects", async () => {
    const harness = createFeedHarness();
    const { result } = renderHook(() =>
      useEventStream("/api/v1/feeds/runs", {
        fetch: harness.fetchMock,
        baseUrl: "http://api.test",
        query: { kind: "hello", target_id: undefined },
      }),
    );
    expect(result.current.status).toBe("connecting");
    await flush();

    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.connections[0]?.request.url).toBe(
      "http://api.test/api/v1/feeds/runs?kind=hello",
    );
  });

  it("surfaces events and hello through the latest callbacks", async () => {
    const harness = createFeedHarness();
    const received: KnownStreamEvent[] = [];
    const hellos: boolean[] = [];
    const { result } = renderHook(() =>
      useEventStream("/api/v1/feeds/runs", {
        fetch: harness.fetchMock,
        baseUrl: "http://api.test",
        onEvent: (event) => received.push(event),
        onHello: (_event, context) => hellos.push(context.reconnect),
      }),
    );
    await flush();
    harness.latest.push(sseFrame("stream.hello", helloEnvelope()));
    harness.latest.push(sseFrame("hello.tick", tickEnvelope(1)));
    await flush();

    expect(result.current).toMatchObject({ status: "live", helloCount: 1 });
    expect(received.map((event) => event.type)).toEqual(["stream.hello", "hello.tick"]);
    expect(hellos).toEqual([false]);
  });

  it("delivers each event once under a StrictMode double mount", async () => {
    const harness = createFeedHarness();
    const received: KnownStreamEvent[] = [];
    renderHook(
      () =>
        useEventStream("/api/v1/feeds/runs", {
          fetch: harness.fetchMock,
          baseUrl: "http://api.test",
          onEvent: (event) => received.push(event),
        }),
      { wrapper: StrictMode },
    );
    await flush();

    const live = harness.connections.filter((connection) => !connection.aborted);
    expect(live).toHaveLength(1);
    live[0]?.push(sseFrame("stream.hello", helloEnvelope()));
    live[0]?.push(sseFrame("hello.tick", tickEnvelope(1)));
    await flush();

    expect(received.map((event) => event.type)).toEqual(["stream.hello", "hello.tick"]);
  });

  it("aborts on unmount and stays idle without a path", async () => {
    const harness = createFeedHarness();
    const { unmount } = renderHook(() =>
      useEventStream("/api/v1/feeds/runs", {
        fetch: harness.fetchMock,
        baseUrl: "http://api.test",
      }),
    );
    await flush();
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(harness.connections[0]?.aborted).toBe(true);
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);

    const idle = createFeedHarness();
    const { result } = renderHook(() =>
      useEventStream(null, { fetch: idle.fetchMock, baseUrl: "http://api.test" }),
    );
    await flush();
    expect(result.current.status).toBe("idle");
    expect(idle.fetchMock).not.toHaveBeenCalled();
  });

  it("opens a new stream when the query changes and aborts the previous one", async () => {
    const harness = createFeedHarness();
    const { rerender } = renderHook(
      ({ kind }: { kind: string }) =>
        useEventStream("/api/v1/feeds/runs", {
          fetch: harness.fetchMock,
          baseUrl: "http://api.test",
          query: { kind },
        }),
      { initialProps: { kind: "hello" } },
    );
    await flush();
    rerender({ kind: "suite" });
    await flush();

    expect(harness.connections).toHaveLength(2);
    expect(harness.connections[0]?.aborted).toBe(true);
    expect(harness.connections[1]?.request.url).toContain("kind=suite");
  });

  it("does not connect while disabled", async () => {
    const harness = createFeedHarness();
    const { result } = renderHook(() =>
      useEventStream("/api/v1/feeds/runs", {
        fetch: harness.fetchMock,
        baseUrl: "http://api.test",
        enabled: false,
      }),
    );
    await flush();

    expect(result.current.status).toBe("idle");
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });
});
