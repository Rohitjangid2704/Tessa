import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, TileFramePayload } from "@/features/streams/events";
import { FIXTURE_SESSION_ID, FIXTURE_TIMESTAMP } from "@/tests/utils/stream-fixtures";
import {
  FrameBus,
  base64ToBytes,
  useFrameBus,
  useFrameBusStats,
  useFrameBusTransport,
  type ImageDecoder,
  type PaintedFrame,
  type TileSink,
} from "./frame-bus";

const SESSION_A = FIXTURE_SESSION_ID;
const SESSION_B = "0198f6f2-8a11-7c33-8e02-19d0a5a7c9b5";
const JPEG_BASE64 = "/9j/4AAQSkZJRgABAQ==";

function frame(session: string, frameSeq: number): TileFramePayload {
  return {
    browser_session_id: session,
    frame_seq: frameSeq,
    mime: "image/jpeg",
    width: 640,
    height: 400,
    data_b64: JPEG_BASE64,
    page_url: null,
    captured_at: FIXTURE_TIMESTAMP,
  };
}

interface FakeBitmap {
  id: number;
  width: number;
  height: number;
  closed: boolean;
  close: () => void;
}

function createHarness(options: { maxTiles?: number } = {}) {
  let clock = 0;
  const bitmaps: FakeBitmap[] = [];
  const pendingDecodes: Array<{
    blob: Blob;
    resolve: (bitmap: ImageBitmap) => void;
    reject: (error: unknown) => void;
  }> = [];
  const decode: ImageDecoder = (blob) =>
    new Promise((resolve, reject) => {
      pendingDecodes.push({ blob, resolve, reject });
    });
  const frameCallbacks: Array<() => void> = [];
  const scheduleFrame = vi.fn((callback: () => void) => {
    frameCallbacks.push(callback);
    return () => {
      const index = frameCallbacks.indexOf(callback);
      if (index >= 0) {
        frameCallbacks.splice(index, 1);
      }
    };
  });
  const sent: ClientMessage[] = [];
  const send = vi.fn((message: ClientMessage) => {
    sent.push(message);
    return true;
  });
  const bus = new FrameBus({
    decode,
    scheduleFrame,
    now: () => clock,
    statsIntervalMs: 500,
    maxTiles: options.maxTiles,
  });

  function completeDecode(index: number, durationMs = 2): FakeBitmap {
    const pending = pendingDecodes[index];
    if (pending === undefined) {
      throw new Error(`no decode ${index}`);
    }
    clock += durationMs;
    const bitmap: FakeBitmap = {
      id: bitmaps.length,
      width: 640,
      height: 400,
      closed: false,
      close() {
        this.closed = true;
      },
    };
    bitmaps.push(bitmap);
    pending.resolve(bitmap as unknown as ImageBitmap);
    return bitmap;
  }

  const painted: Array<{ session: string; frame: PaintedFrame; bitmap: FakeBitmap }> = [];
  function sinkFor(session: string): TileSink {
    return {
      paint: (image, info) =>
        painted.push({ session, frame: info, bitmap: image as unknown as FakeBitmap }),
    };
  }

  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  function runFrame(): void {
    const callback = frameCallbacks.shift();
    callback?.();
  }

  return {
    bus,
    bitmaps,
    pendingDecodes,
    frameCallbacks,
    scheduleFrame,
    sent,
    send,
    painted,
    sinkFor,
    completeDecode,
    settle,
    runFrame,
    advanceClock: (ms: number) => {
      clock += ms;
    },
    subscribes: () =>
      sent.filter((message) => message.type === "tile.subscribe").map((message) => message.payload),
    acks: () =>
      sent.filter((message) => message.type === "tile.ack").map((message) => message.payload),
  };
}

async function attachVisible(harness: ReturnType<typeof createHarness>, session = SESSION_A) {
  const detach = harness.bus.attach(session, harness.sinkFor(session));
  harness.bus.setTileVisible(session, true);
  await harness.settle();
  return detach;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("base64ToBytes", () => {
  it("decodes base64 to the original bytes", () => {
    expect([...base64ToBytes(JPEG_BASE64)].slice(0, 4)).toEqual([0xff, 0xd8, 0xff, 0xe0]);
  });
});

describe("FrameBus latest wins", () => {
  it("decodes a frame, paints it on the next animation frame and acks it", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    await attachVisible(harness);

    harness.bus.publish(frame(SESSION_A, 1));
    expect(harness.pendingDecodes).toHaveLength(1);
    expect(harness.pendingDecodes[0]?.blob.type).toBe("image/jpeg");
    const bitmap = harness.completeDecode(0);
    await harness.settle();
    expect(harness.scheduleFrame).toHaveBeenCalledTimes(1);
    expect(harness.painted).toHaveLength(0);

    harness.runFrame();

    expect(harness.painted).toHaveLength(1);
    expect(harness.painted[0]).toMatchObject({
      session: SESSION_A,
      frame: { frameSeq: 1, width: 640, height: 400, pageUrl: null },
    });
    expect(bitmap.closed).toBe(true);
    expect(harness.acks()).toEqual([{ browser_session_id: SESSION_A, frame_seq: 1 }]);
    expect(harness.bus.getState()).toMatchObject({ received: 0 });
    harness.bus.flushStats();
    expect(harness.bus.getState()).toMatchObject({ received: 1, painted: 1, dropped: 0 });
  });

  it("keeps only the newest of several frames that arrive during a decode", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    await attachVisible(harness);

    harness.bus.publish(frame(SESSION_A, 1));
    harness.bus.publish(frame(SESSION_A, 2));
    harness.bus.publish(frame(SESSION_A, 3));
    harness.bus.publish(frame(SESSION_A, 4));
    expect(harness.pendingDecodes).toHaveLength(1);

    harness.completeDecode(0);
    await harness.settle();
    expect(harness.pendingDecodes).toHaveLength(2);
    harness.completeDecode(1);
    await harness.settle();
    harness.runFrame();

    expect(harness.painted.map((entry) => entry.frame.frameSeq)).toEqual([4]);
    expect(harness.acks()).toEqual([{ browser_session_id: SESSION_A, frame_seq: 4 }]);
    harness.bus.flushStats();
    expect(harness.bus.getState()).toMatchObject({ received: 4, painted: 1, dropped: 3 });
  });

  it("drops a decoded frame that is superseded before the paint and closes its bitmap", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    await attachVisible(harness);

    harness.bus.publish(frame(SESSION_A, 1));
    const first = harness.completeDecode(0);
    await harness.settle();
    harness.bus.publish(frame(SESSION_A, 2));
    const second = harness.completeDecode(1);
    await harness.settle();
    harness.runFrame();

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(harness.painted.map((entry) => entry.frame.frameSeq)).toEqual([2]);
    harness.bus.flushStats();
    expect(harness.bus.getState()).toMatchObject({ painted: 1, dropped: 1 });
  });

  it("paints every tile in one animation frame and sends one cumulative ack per tile", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    await attachVisible(harness, SESSION_A);
    await attachVisible(harness, SESSION_B);

    harness.bus.publish(frame(SESSION_A, 5));
    harness.bus.publish(frame(SESSION_B, 9));
    harness.completeDecode(0);
    harness.completeDecode(1);
    await harness.settle();

    expect(harness.scheduleFrame).toHaveBeenCalledTimes(1);
    harness.runFrame();

    expect(harness.painted).toHaveLength(2);
    expect(harness.acks()).toEqual([
      { browser_session_id: SESSION_A, frame_seq: 5 },
      { browser_session_id: SESSION_B, frame_seq: 9 },
    ]);
  });

  it("does not ack an older superseded frame on its own", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    await attachVisible(harness);

    harness.bus.publish(frame(SESSION_A, 1));
    harness.bus.publish(frame(SESSION_A, 2));
    await harness.settle();

    expect(harness.acks()).toEqual([]);
  });

  it("acks and counts a frame for a tile that has no canvas, without decoding it", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);

    harness.bus.publish(frame(SESSION_B, 7));
    await harness.settle();

    expect(harness.pendingDecodes).toHaveLength(0);
    expect(harness.acks()).toEqual([{ browser_session_id: SESSION_B, frame_seq: 7 }]);
    harness.bus.flushStats();
    expect(harness.bus.getState()).toMatchObject({ received: 1, dropped: 1, painted: 0 });
  });

  it("acks a frame for a tile that is not visible instead of decoding it", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    harness.bus.attach(SESSION_A, harness.sinkFor(SESSION_A));
    await harness.settle();

    harness.bus.publish(frame(SESSION_A, 3));
    await harness.settle();

    expect(harness.pendingDecodes).toHaveLength(0);
    expect(harness.acks()).toEqual([{ browser_session_id: SESSION_A, frame_seq: 3 }]);
  });

  it("counts a decode failure, acks the frame so the window frees, and keeps going", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    await attachVisible(harness);

    harness.bus.publish(frame(SESSION_A, 1));
    harness.pendingDecodes[0]?.reject(new Error("bad jpeg"));
    await harness.settle();
    expect(harness.acks()).toEqual([{ browser_session_id: SESSION_A, frame_seq: 1 }]);

    harness.bus.publish(frame(SESSION_A, 2));
    harness.completeDecode(1);
    await harness.settle();
    harness.runFrame();

    harness.bus.flushStats();
    expect(harness.bus.getState()).toMatchObject({ decodeErrors: 1, painted: 1, dropped: 1 });
    expect(harness.painted).toHaveLength(1);
  });

  it("survives a decoder that throws synchronously", async () => {
    const bus = new FrameBus({
      decode: () => {
        throw new Error("no decoder");
      },
      scheduleFrame: () => () => {},
    });
    const sent: ClientMessage[] = [];
    bus.setTransport((message) => {
      sent.push(message);
      return true;
    });
    bus.attach(SESSION_A, { paint: () => {} });
    bus.setTileVisible(SESSION_A, true);
    bus.publish(frame(SESSION_A, 1));
    await Promise.resolve();
    await Promise.resolve();

    bus.flushStats();
    expect(bus.getState().decodeErrors).toBe(1);
  });

  it("does not let a sink that throws stop the paint loop", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    harness.bus.attach(SESSION_A, {
      paint: () => {
        throw new Error("canvas lost");
      },
    });
    harness.bus.setTileVisible(SESSION_A, true);
    await harness.settle();
    harness.bus.publish(frame(SESSION_A, 1));
    const bitmap = harness.completeDecode(0);
    await harness.settle();
    harness.runFrame();

    expect(bitmap.closed).toBe(true);
    expect(harness.acks()).toHaveLength(1);
    harness.bus.flushStats();
    expect(harness.bus.getState()).toMatchObject({ painted: 0, dropped: 1 });
  });

  it("records decode durations for the percentile stats", async () => {
    const harness = createHarness();
    harness.bus.start();
    await attachVisible(harness);

    for (let index = 0; index < 20; index += 1) {
      harness.bus.publish(frame(SESSION_A, index + 1));
      harness.completeDecode(index, index === 19 ? 30 : 2);
      await harness.settle();
    }
    harness.bus.flushStats();

    const stats = harness.bus.getState();
    expect(stats.decodeP50Ms).toBeGreaterThanOrEqual(2);
    expect(stats.decodeP50Ms).toBeLessThan(3);
    expect(stats.decodeMaxMs).toBe(30);
    expect(stats.decodeP95Ms).toBeGreaterThanOrEqual(2);
  });

  it("records handler samples and received bytes", () => {
    const harness = createHarness();
    harness.bus.recordHandlerSample(0.4);
    harness.bus.recordHandlerSample(0.6);
    harness.bus.recordHandlerSample(7);
    harness.bus.publish(frame(SESSION_A, 1));
    harness.bus.flushStats();

    const stats = harness.bus.getState();
    expect(stats.handlerSamples).toBe(3);
    expect(stats.handlerMaxMs).toBe(7);
    expect(stats.bytesReceived).toBe(JPEG_BASE64.length);
  });

  it("resets counters and histograms", async () => {
    const harness = createHarness();
    harness.bus.recordHandlerSample(2);
    harness.bus.publish(frame(SESSION_A, 1));
    harness.bus.resetStats();

    expect(harness.bus.getState()).toMatchObject({
      received: 0,
      dropped: 0,
      handlerSamples: 0,
      bytesReceived: 0,
    });
  });
});

describe("FrameBus subscription", () => {
  it("sends tile.subscribe for the visible tiles once, coalescing a burst of changes", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.attach(SESSION_A, harness.sinkFor(SESSION_A));
    harness.bus.attach(SESSION_B, harness.sinkFor(SESSION_B));
    harness.bus.setTransport(harness.send);
    harness.bus.setTileVisible(SESSION_A, true);
    harness.bus.setTileVisible(SESSION_B, true);
    harness.bus.setTileVisible(SESSION_B, false);
    harness.bus.setTileVisible(SESSION_B, true);
    await harness.settle();

    expect(harness.subscribes()).toEqual([
      {
        tiles: [
          { browser_session_id: SESSION_A, mode: "grid" },
          { browser_session_id: SESSION_B, mode: "grid" },
        ],
      },
    ]);
  });

  it("replaces the set when a tile scrolls out of view", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    await attachVisible(harness, SESSION_A);
    await attachVisible(harness, SESSION_B);

    harness.bus.setTileVisible(SESSION_A, false);
    await harness.settle();

    expect(harness.subscribes().at(-1)).toEqual({
      tiles: [{ browser_session_id: SESSION_B, mode: "grid" }],
    });
    harness.bus.flushStats();
    expect(harness.bus.getState()).toMatchObject({ subscribedTiles: 1, visibleTiles: 1 });
  });

  it("sends the focus mode of a tile and does not resend an unchanged set", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    await attachVisible(harness);
    const before = harness.subscribes().length;

    harness.bus.setTileMode(SESSION_A, "focus");
    await harness.settle();
    harness.bus.setTileVisible(SESSION_A, true);
    harness.bus.setTileMode(SESSION_A, "focus");
    await harness.settle();

    expect(harness.subscribes()).toHaveLength(before + 1);
    expect(harness.subscribes().at(-1)).toEqual({
      tiles: [{ browser_session_id: SESSION_A, mode: "focus" }],
    });
  });

  it("caps the subscription at max_tiles in attach order", async () => {
    const harness = createHarness({ maxTiles: 2 });
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    for (const id of ["s1", "s2", "s3"]) {
      await attachVisible(harness, id);
    }

    expect(harness.bus.currentSubscription().map((tile) => tile.browser_session_id)).toEqual([
      "s1",
      "s2",
    ]);
    harness.bus.setMaxTiles(3);
    await harness.settle();
    expect(harness.subscribes().at(-1)?.tiles).toHaveLength(3);
  });

  it("sends nothing while disconnected and resubscribes after a reconnect", async () => {
    const harness = createHarness();
    harness.bus.start();
    await attachVisible(harness);
    expect(harness.subscribes()).toHaveLength(0);

    harness.bus.setTransport(harness.send);
    await harness.settle();
    expect(harness.subscribes()).toHaveLength(1);

    harness.bus.setTransport(null);
    harness.bus.setTransport(harness.send);
    await harness.settle();
    expect(harness.subscribes()).toHaveLength(2);
  });

  it("restarts ack numbering on a new connection so a restarted frame_seq is acked", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    await attachVisible(harness);
    harness.bus.publish(frame(SESSION_A, 300));
    harness.completeDecode(0);
    await harness.settle();
    harness.runFrame();
    expect(harness.acks().at(-1)).toEqual({ browser_session_id: SESSION_A, frame_seq: 300 });

    harness.bus.setTransport(null);
    harness.bus.setTransport(harness.send);
    await harness.settle();
    harness.bus.publish(frame(SESSION_A, 1));
    harness.completeDecode(1);
    await harness.settle();
    harness.runFrame();

    expect(harness.acks().at(-1)).toEqual({ browser_session_id: SESSION_A, frame_seq: 1 });
  });

  it("holds an ack when the send fails and retries it with the next one", async () => {
    const harness = createHarness();
    harness.bus.start();
    let open = false;
    harness.bus.setTransport((message) => {
      if (!open) {
        return false;
      }
      harness.sent.push(message);
      return true;
    });
    await attachVisible(harness);
    harness.bus.publish(frame(SESSION_A, 1));
    harness.completeDecode(0);
    await harness.settle();
    harness.runFrame();
    expect(harness.acks()).toEqual([]);

    open = true;
    harness.bus.publish(frame(SESSION_A, 2));
    harness.completeDecode(1);
    await harness.settle();
    harness.runFrame();

    expect(harness.acks()).toEqual([{ browser_session_id: SESSION_A, frame_seq: 2 }]);
  });

  it("detaching a tile unsubscribes it and drops its decoded frame", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    const detach = await attachVisible(harness);
    harness.bus.publish(frame(SESSION_A, 1));
    const bitmap = harness.completeDecode(0);
    await harness.settle();

    detach();
    await harness.settle();

    expect(bitmap.closed).toBe(true);
    expect(harness.subscribes().at(-1)).toEqual({ tiles: [] });
    expect(harness.acks().at(-1)).toEqual({ browser_session_id: SESSION_A, frame_seq: 1 });
  });
});

describe("FrameBus page visibility", () => {
  function setVisibility(state: "visible" | "hidden"): void {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  afterEach(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("unsubscribes everything and drops decoded frames when the page is hidden, then resumes", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.setTransport(harness.send);
    await attachVisible(harness);
    harness.bus.publish(frame(SESSION_A, 1));
    const bitmap = harness.completeDecode(0);
    await harness.settle();

    setVisibility("hidden");
    await harness.settle();

    expect(bitmap.closed).toBe(true);
    expect(harness.subscribes().at(-1)).toEqual({ tiles: [] });
    harness.bus.flushStats();
    expect(harness.bus.getState().pageVisible).toBe(false);

    harness.bus.publish(frame(SESSION_A, 2));
    await harness.settle();
    expect(harness.pendingDecodes).toHaveLength(1);
    expect(harness.acks().at(-1)).toEqual({ browser_session_id: SESSION_A, frame_seq: 2 });

    setVisibility("visible");
    await harness.settle();
    expect(harness.subscribes().at(-1)).toEqual({
      tiles: [{ browser_session_id: SESSION_A, mode: "grid" }],
    });
  });

  it("stops listening after stop() and ignores later visibility changes", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.stop();
    setVisibility("hidden");
    harness.bus.flushStats();

    expect(harness.bus.getState().pageVisible).toBe(true);
  });

  it("start and stop are reference counted for a StrictMode double mount", () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.start();
    harness.bus.stop();
    setVisibility("hidden");
    harness.bus.flushStats();
    expect(harness.bus.getState().pageVisible).toBe(false);

    harness.bus.stop();
    setVisibility("visible");
    harness.bus.flushStats();
    expect(harness.bus.getState().pageVisible).toBe(false);
  });
});

describe("FrameBus stats timer", () => {
  it("publishes the stats store every interval while started", async () => {
    const harness = createHarness();
    harness.bus.start();
    harness.bus.publish(frame(SESSION_B, 1));
    expect(harness.bus.getState().received).toBe(0);

    await vi.advanceTimersByTimeAsync(500);

    expect(harness.bus.getState().received).toBe(1);
    harness.bus.stop();
    harness.bus.publish(frame(SESSION_B, 2));
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.bus.getState().received).toBe(1);
  });
});

describe("frame bus hooks", () => {
  it("creates one bus under StrictMode and keeps its timers balanced", () => {
    const { result, unmount } = renderHook(() => useFrameBus(), { wrapper: StrictMode });
    const bus = result.current;
    expect(bus).toBeInstanceOf(FrameBus);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wires the transport on connect and detaches it on disconnect", async () => {
    const sent: ClientMessage[] = [];
    const send = (message: ClientMessage) => {
      sent.push(message);
      return true;
    };
    const { result, rerender } = renderHook(
      ({ connected }: { connected: boolean }) => {
        const bus = useFrameBus();
        useFrameBusTransport(bus, send, connected, 6);
        return { bus, stats: useFrameBusStats(bus) };
      },
      { initialProps: { connected: false } },
    );
    result.current.bus.attach(SESSION_A, { paint: () => {} });
    result.current.bus.setTileVisible(SESSION_A, true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(sent).toHaveLength(0);

    rerender({ connected: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("tile.subscribe");

    rerender({ connected: false });
    result.current.bus.setTileVisible(SESSION_A, false);
    result.current.bus.setTileVisible(SESSION_A, true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(sent).toHaveLength(1);
  });

  it("re-renders from the stats store", async () => {
    const { result } = renderHook(() => {
      const bus = useFrameBus({ statsIntervalMs: 100 });
      return { bus, stats: useFrameBusStats(bus) };
    });
    result.current.bus.publish(frame(SESSION_B, 1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.stats.received).toBe(1);
  });
});
