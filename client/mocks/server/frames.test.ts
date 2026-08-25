import { decode } from "jpeg-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamLimits } from "@/features/streams/events";
import { STREAM_LIMITS } from "./ws";
import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  FrameStreamer,
  MAX_UNACKED_FRAMES_PER_TILE,
  createFrameSessions,
  getFramePool,
  renderFrame,
  type FrameSession,
} from "./frames";
import type { EventEnvelope } from "../types";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const FIXED_POOL = {
  variants: 4,
  frameFor: () => ({ dataBase64: "AAAA", width: FRAME_WIDTH, height: FRAME_HEIGHT, byteLength: 3 }),
};

function createHarness(
  options: { sessions?: number; limits?: StreamLimits; buffered?: number } = {},
) {
  const sessions = createFrameSessions(options.sessions ?? 12);
  const sent: EventEnvelope[] = [];
  let buffered = options.buffered ?? 0;
  const streamer = new FrameStreamer({
    runId: "run-1",
    sessions,
    pool: FIXED_POOL,
    limits: options.limits ?? STREAM_LIMITS,
    sink: { send: (envelope) => sent.push(envelope), bufferedAmount: () => buffered },
  });
  const framesOf = (session: FrameSession) =>
    sent.filter(
      (envelope) =>
        (envelope.payload as { browser_session_id: string }).browser_session_id === session.id,
    );
  const ackAll = () => {
    for (const session of sessions) {
      const frames = framesOf(session);
      const newest = frames.at(-1);
      if (newest !== undefined) {
        streamer.handle({
          type: "tile.ack",
          payload: {
            browser_session_id: session.id,
            frame_seq: (newest.payload as { frame_seq: number }).frame_seq,
          },
        });
      }
    }
  };
  return {
    sessions,
    sent,
    streamer,
    framesOf,
    ackAll,
    setBuffered: (bytes: number) => {
      buffered = bytes;
    },
  };
}

describe("renderFrame", () => {
  it("renders a decodable 640 by 400 JPEG of about 80 KB in base64", () => {
    const frame = renderFrame(3, 1);
    const bytes = Buffer.from(frame.dataBase64, "base64");
    const decoded = decode(bytes, { useTArray: true });

    expect(decoded.width).toBe(640);
    expect(decoded.height).toBe(400);
    expect(bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(frame.byteLength).toBe(bytes.length);
    expect(frame.dataBase64.length).toBeGreaterThan(70_000);
    expect(frame.dataBase64.length).toBeLessThan(100_000);
  });

  it("renders different content per session and per variant", () => {
    const first = renderFrame(0, 0).dataBase64;
    expect(renderFrame(1, 0).dataBase64).not.toBe(first);
    expect(renderFrame(0, 1).dataBase64).not.toBe(first);
    expect(renderFrame(0, 0).dataBase64).toBe(first);
  });
});

describe("getFramePool", () => {
  it("pre-renders and caches one frame per session and variant, cycling by frame_seq", async () => {
    vi.useRealTimers();
    const pool = await getFramePool(2, 2);

    expect(await getFramePool(2, 2)).toBe(pool);
    expect(pool.frameFor(0, 0)).toBe(pool.frameFor(0, 2));
    expect(pool.frameFor(0, 0)).not.toBe(pool.frameFor(0, 1));
    expect(pool.frameFor(1, 0)).not.toBe(pool.frameFor(0, 0));
    expect(pool.frameFor(2, 0)).toBe(pool.frameFor(0, 0));
  });
});

describe("FrameStreamer", () => {
  it("subscribes every session as grid by default, up to max_tiles", () => {
    const harness = createHarness({ sessions: 14 });
    harness.streamer.start();

    expect(Object.keys(harness.streamer.subscribedModes)).toHaveLength(12);
    expect(new Set(Object.values(harness.streamer.subscribedModes))).toEqual(new Set(["grid"]));
  });

  it("emits tile.frame envelopes with seq null and the payload of the contract", async () => {
    const harness = createHarness({ sessions: 1 });
    harness.streamer.start();
    await vi.advanceTimersByTimeAsync(1000);

    const [first] = harness.sent;
    expect(first).toMatchObject({ type: "tile.frame", run_id: "run-1", seq: null });
    expect(first?.payload).toMatchObject({
      browser_session_id: harness.sessions[0]?.id,
      frame_seq: 1,
      mime: "image/jpeg",
      width: 640,
      height: 400,
      data_b64: "AAAA",
    });
    expect(first?.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("runs each grid tile at 4 fps while acknowledged", async () => {
    const harness = createHarness({ sessions: 3 });
    harness.streamer.start();
    for (let second = 0; second < 5; second += 1) {
      await vi.advanceTimersByTimeAsync(250);
      harness.ackAll();
    }
    await vi.advanceTimersByTimeAsync(0);

    for (const session of harness.sessions) {
      const count = harness.framesOf(session).length;
      expect(count).toBeGreaterThanOrEqual(4);
      expect(count).toBeLessThanOrEqual(6);
    }
    expect(harness.streamer.stats.sent).toBe(harness.sent.length);
  });

  it("never has more than 2 unacked frames per tile and counts the skipped ones", async () => {
    const harness = createHarness({ sessions: 1 });
    harness.streamer.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(harness.framesOf(harness.sessions[0] as FrameSession)).toHaveLength(
      MAX_UNACKED_FRAMES_PER_TILE,
    );
    expect(harness.streamer.stats.skippedWindowFull).toBeGreaterThan(10);
  });

  it("frees the window with a cumulative ack and keeps frame_seq increasing", async () => {
    const harness = createHarness({ sessions: 1 });
    const [session] = harness.sessions as [FrameSession];
    harness.streamer.start();
    await vi.advanceTimersByTimeAsync(1000);
    const delivered = harness
      .framesOf(session)
      .map((envelope) => (envelope.payload as { frame_seq: number }).frame_seq);
    expect(delivered).toEqual([1, 2]);

    harness.streamer.handle({
      type: "tile.ack",
      payload: { browser_session_id: session.id, frame_seq: 2 },
    });
    await vi.advanceTimersByTimeAsync(1000);

    const afterAck = harness
      .framesOf(session)
      .map((envelope) => (envelope.payload as { frame_seq: number }).frame_seq);
    expect(afterAck.slice(0, 2)).toEqual([1, 2]);
    expect(afterAck.length).toBe(4);
    expect(afterAck.every((seq, index) => index === 0 || seq > (afterAck[index - 1] ?? 0))).toBe(
      true,
    );
  });

  it("treats an ack as cumulative: acking the newest frame clears both in flight", async () => {
    const harness = createHarness({ sessions: 1 });
    const [session] = harness.sessions as [FrameSession];
    harness.streamer.start();
    await vi.advanceTimersByTimeAsync(600);
    expect(harness.framesOf(session)).toHaveLength(2);

    harness.streamer.handle({
      type: "tile.ack",
      payload: { browser_session_id: session.id, frame_seq: 2 },
    });
    await vi.advanceTimersByTimeAsync(260);

    expect(harness.framesOf(session)).toHaveLength(3);
  });

  it("replaces the subscription set: unlisted tiles stop, listed tiles start", async () => {
    const harness = createHarness({ sessions: 4 });
    const [first, second] = harness.sessions as [FrameSession, FrameSession];
    harness.streamer.start();
    harness.streamer.handle({
      type: "tile.subscribe",
      payload: { tiles: [{ browser_session_id: second.id, mode: "grid" }] },
    });
    harness.sent.length = 0;
    await vi.advanceTimersByTimeAsync(600);

    expect(harness.framesOf(first)).toHaveLength(0);
    expect(harness.framesOf(second).length).toBeGreaterThan(0);
    expect(harness.streamer.subscribedModes).toEqual({ [second.id]: "grid" });
  });

  it("pauses everything on an empty subscription and resumes on a new one", async () => {
    const harness = createHarness({ sessions: 2 });
    harness.streamer.start();
    harness.streamer.handle({ type: "tile.subscribe", payload: { tiles: [] } });
    harness.sent.length = 0;
    await vi.advanceTimersByTimeAsync(2000);
    expect(harness.sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    harness.streamer.handle({
      type: "tile.subscribe",
      payload: { tiles: [{ browser_session_id: harness.sessions[0]?.id ?? "", mode: "grid" }] },
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(harness.sent.length).toBeGreaterThan(0);
  });

  it("runs a focus tile at 10 fps", async () => {
    const harness = createHarness({ sessions: 1 });
    const [session] = harness.sessions as [FrameSession];
    harness.streamer.handle({
      type: "tile.subscribe",
      payload: { tiles: [{ browser_session_id: session.id, mode: "focus" }] },
    });
    for (let step = 0; step < 10; step += 1) {
      await vi.advanceTimersByTimeAsync(100);
      harness.ackAll();
    }

    expect(harness.framesOf(session).length).toBeGreaterThanOrEqual(9);
    expect(harness.framesOf(session).length).toBeLessThanOrEqual(11);
  });

  it("does not resubscribe a tile whose mode is unchanged", async () => {
    const harness = createHarness({ sessions: 1 });
    const [session] = harness.sessions as [FrameSession];
    harness.streamer.start();
    await vi.advanceTimersByTimeAsync(300);
    const before = harness.sent.length;
    harness.streamer.handle({
      type: "tile.subscribe",
      payload: { tiles: [{ browser_session_id: session.id, mode: "grid" }] },
    });

    expect(harness.sent).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("returns invalid for malformed messages and for more tiles than max_tiles", () => {
    const harness = createHarness({ sessions: 14 });
    const tooMany = harness.sessions.map((session) => ({
      browser_session_id: session.id,
      mode: "grid" as const,
    }));

    expect(harness.streamer.handle({ type: "tile.subscribe", payload: { tiles: tooMany } })).toBe(
      "invalid",
    );
    expect(harness.streamer.handle({ type: "tile.ack", payload: { frame_seq: 1 } })).toBe(
      "invalid",
    );
    expect(harness.streamer.handle({ type: "tile.nope", payload: {} })).toBe("invalid");
    expect(
      harness.streamer.handle({
        type: "tile.subscribe",
        payload: { tiles: [{ browser_session_id: "x", mode: "grid" }] },
      }),
    ).toBe("invalid");
  });

  it("ignores subscriptions and acks for sessions it does not know", () => {
    const harness = createHarness({ sessions: 1 });
    const unknown = "0198f6f2-8a11-7c33-8e02-19d0a5a7c9ff";

    expect(
      harness.streamer.handle({
        type: "tile.subscribe",
        payload: { tiles: [{ browser_session_id: unknown, mode: "grid" }] },
      }),
    ).toBe("handled");
    expect(
      harness.streamer.handle({
        type: "tile.ack",
        payload: { browser_session_id: unknown, frame_seq: 3 },
      }),
    ).toBe("handled");
    expect(harness.streamer.subscribedModes).toEqual({});
  });

  it("skips frames while the socket buffer is over the limit", async () => {
    const harness = createHarness({ sessions: 1, buffered: 8 * 1024 * 1024 });
    harness.streamer.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(harness.sent).toHaveLength(0);
    expect(harness.streamer.stats.skippedBackpressure).toBeGreaterThan(0);

    harness.setBuffered(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(harness.sent.length).toBeGreaterThan(0);
  });

  it("counts subscribes and acks and stops all timers on stop()", async () => {
    const harness = createHarness({ sessions: 3 });
    harness.streamer.start();
    harness.streamer.handle({
      type: "tile.ack",
      payload: { browser_session_id: harness.sessions[0]?.id ?? "", frame_seq: 1 },
    });
    expect(harness.streamer.stats).toMatchObject({ acks: 1, subscribes: 0 });

    harness.streamer.stop();
    harness.sent.length = 0;
    await vi.advanceTimersByTimeAsync(5000);

    expect(harness.sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("staggers the tiles so a second of frames is not one burst", async () => {
    const harness = createHarness({ sessions: 12 });
    harness.streamer.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(harness.sent.length).toBeLessThan(6);
  });
});
