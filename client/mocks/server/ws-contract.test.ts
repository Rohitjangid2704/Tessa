import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEMBER_USER } from "@/mocks/factories/users";
import type { RunningMockServer } from "@/mocks/server/http";
import { STREAM_LIMITS } from "@/mocks/server/ws";
import { mockState } from "@/mocks/state";
import {
  createHelloRun,
  openRunSocket,
  requestWsTicket,
  startMockApi,
  type ReceivedFrame,
  type SocketProbe,
} from "@/tests/utils/mock-api";
import { mintApiToken } from "@/tests/utils/tokens";

const ALLOWED_ORIGIN = "http://localhost:3000";
const FOREIGN_ORIGIN = "http://evil.example";
const FAST_HELLO = { ticks: 3, tick_interval_ms: 100 } as const;
const LONG_HELLO = { ticks: 6, tick_interval_ms: 100 } as const;

let running: RunningMockServer;
let token: string;
const openProbes: SocketProbe[] = [];

beforeAll(async () => {
  running = await startMockApi();
});

afterAll(async () => {
  await running.close();
});

beforeEach(async () => {
  mockState.reset();
  mockState.restoreConfig();
  token = await mintApiToken();
});

afterEach(() => {
  for (const probe of openProbes.splice(0)) {
    probe.close();
  }
});

async function connect(
  runId: string,
  {
    lastSeq,
    origin,
    ticketToken = token,
  }: { lastSeq?: number; origin?: string; ticketToken?: string } = {},
): Promise<SocketProbe> {
  const ticket = await requestWsTicket(running.baseUrl, ticketToken, runId);
  const suffix = lastSeq === undefined ? "" : `&last_seq=${lastSeq}`;
  const probe = openRunSocket(`${ticket.ws_url}${suffix}`, origin);
  openProbes.push(probe);
  return probe;
}

function persistedTypes(frames: ReceivedFrame[]): string[] {
  return frames.filter((frame) => frame.seq !== null).map((frame) => frame.type);
}

function seqs(frames: ReceivedFrame[]): number[] {
  return frames.flatMap((frame) => (frame.seq === null ? [] : [frame.seq]));
}

function findGapIndex(delivered: number[]): number {
  return delivered.findIndex((seq, index) => index > 0 && seq !== (delivered[index - 1] ?? 0) + 1);
}

describe("hello stream order", () => {
  it("sends stream.hello, the replay, stream.replay_end, then the live hello events", async () => {
    const handle = await createHelloRun(running.baseUrl, token, FAST_HELLO);
    const probe = await connect(handle.run_id);

    await probe.waitForType("run.finished");

    const first = probe.frames[0];
    expect(first?.type).toBe("stream.hello");
    expect(first).toMatchObject({ run_id: handle.run_id, seq: null });
    const replayEndIndex = probe.types.indexOf("stream.replay_end");
    expect(replayEndIndex).toBeGreaterThan(0);
    const headSeq = Number(first?.payload.head_seq);
    expect(probe.frames.slice(1, replayEndIndex).map((frame) => frame.seq)).toEqual(
      Array.from({ length: headSeq }, (_, index) => index + 1),
    );
    expect(probe.frames[replayEndIndex]?.payload).toEqual({ through_seq: headSeq });

    expect(persistedTypes(probe.frames)).toEqual([
      "run.created",
      "run.status_changed",
      "hello.tick",
      "hello.tick",
      "hello.tick",
      "hello.laya",
      "run.finished",
    ]);
  });

  it("numbers persisted events from 1 without gaps or duplicates", async () => {
    const handle = await createHelloRun(running.baseUrl, token, FAST_HELLO);
    const probe = await connect(handle.run_id);

    await probe.waitForType("run.finished");

    expect(seqs(probe.frames)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("sends ephemeral stream events with seq null and persisted events with a seq", async () => {
    const handle = await createHelloRun(running.baseUrl, token, FAST_HELLO);
    const probe = await connect(handle.run_id);
    await probe.waitForType("run.finished");

    for (const frame of probe.frames) {
      expect(frame.run_id).toBe(handle.run_id);
      expect(frame.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      if (frame.type.startsWith("stream.")) {
        expect(frame.seq).toBeNull();
      } else {
        expect(frame.seq).toEqual(expect.any(Number));
      }
    }
  });

  it("describes the stream in stream.hello", async () => {
    const handle = await createHelloRun(running.baseUrl, token, FAST_HELLO);
    const probe = await connect(handle.run_id);
    await probe.waitForType("stream.replay_end");

    expect(probe.frames[0]?.payload).toEqual({
      run_id: handle.run_id,
      head_seq: expect.any(Number),
      resumed_from: null,
      heartbeat_seconds: 15,
      limits: STREAM_LIMITS,
      feed: null,
    });
    expect(STREAM_LIMITS).toEqual({
      max_tiles: 12,
      grid: { max_fps: 4, quality: 60, max_width: 640 },
      focus: { max_fps: 10, quality: 75, max_width: 1280 },
    });
  });

  it("emits the payloads of the contract", async () => {
    const handle = await createHelloRun(running.baseUrl, token, {
      ticks: 2,
      tick_interval_ms: 100,
    });
    const probe = await connect(handle.run_id);
    await probe.waitForType("run.finished");

    const byType = (type: string) => probe.frames.filter((frame) => frame.type === type);
    expect(byType("run.created")[0]?.payload).toEqual({
      kind: "hello",
      target_id: null,
      plan_id: null,
      trigger: "manual",
      created_by: expect.any(String),
      status: "queued",
    });
    expect(byType("run.status_changed")[0]?.payload).toEqual({
      status: "running",
      previous: "queued",
      reason: null,
    });
    expect(byType("hello.tick").map((frame) => frame.payload)).toEqual([
      { n: 1, total: 2, message: "hello tick 1 of 2" },
      { n: 2, total: 2, message: "hello tick 2 of 2" },
    ]);
    expect(byType("hello.laya")[0]?.payload).toEqual({
      ok: true,
      latency_ms: 14,
      status_code: 200,
      error: null,
    });
    expect(byType("run.finished")[0]?.payload).toEqual({
      status: "completed",
      counters: {
        scenarios_total: 0,
        scenarios_done: 0,
        pass: 0,
        fail: 0,
        flaky: 0,
        uncertain: 0,
        skipped: 0,
        steps_recorded: 0,
      },
      spent_usd: 0,
      duration_ms: expect.any(Number),
    });
  });

  it("omits hello.laya when include_laya is false", async () => {
    const handle = await createHelloRun(running.baseUrl, token, {
      ...FAST_HELLO,
      include_laya: false,
    });
    const probe = await connect(handle.run_id);
    await probe.waitForType("run.finished");

    expect(persistedTypes(probe.frames)).not.toContain("hello.laya");
    expect(persistedTypes(probe.frames)).toHaveLength(6);
  });

  it("spaces the ticks by tick_interval_ms", async () => {
    const handle = await createHelloRun(running.baseUrl, token, {
      ticks: 3,
      tick_interval_ms: 200,
    });
    const probe = await connect(handle.run_id);
    await probe.waitForType("run.finished");

    const tickTimes = probe.frames
      .filter((frame) => frame.type === "hello.tick")
      .map((frame) => Date.parse(frame.ts));
    const gaps = tickTimes.slice(1).map((time, index) => time - (tickTimes[index] ?? 0));
    expect(gaps).toHaveLength(2);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(150);
    }
  });
});

describe("resume with last_seq", () => {
  it("replays only events after last_seq and reports resumed_from", async () => {
    const handle = await createHelloRun(running.baseUrl, token, FAST_HELLO);
    const live = await connect(handle.run_id);
    await live.waitForType("run.finished");

    const resumed = await connect(handle.run_id, { lastSeq: 3 });
    await resumed.waitForType("stream.replay_end");

    expect(resumed.frames[0]?.payload).toMatchObject({ resumed_from: 3, head_seq: 7 });
    expect(seqs(resumed.frames)).toEqual([4, 5, 6, 7]);
    expect(resumed.frames.at(-1)?.type).toBe("stream.replay_end");
    expect(resumed.frames.at(-1)?.payload).toEqual({ through_seq: 7 });
  });

  it("replays nothing when the client is caught up", async () => {
    const handle = await createHelloRun(running.baseUrl, token, FAST_HELLO);
    const live = await connect(handle.run_id);
    await live.waitForType("run.finished");

    const resumed = await connect(handle.run_id, { lastSeq: 7 });
    await resumed.waitForType("stream.replay_end");

    expect(resumed.types).toEqual(["stream.hello", "stream.replay_end"]);
  });

  it("continues live after the replay without a duplicate or a gap", async () => {
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const firstHalf = await connect(handle.run_id);
    await firstHalf.waitUntil(() => seqs(firstHalf.frames).length >= 4);
    const lastGood = Math.max(...seqs(firstHalf.frames));
    firstHalf.close();

    const resumed = await connect(handle.run_id, { lastSeq: lastGood });
    await resumed.waitForType("run.finished");

    const all = [
      ...seqs(firstHalf.frames).filter((seq) => seq <= lastGood),
      ...seqs(resumed.frames),
    ];
    expect(all).toEqual(Array.from({ length: all.length }, (_, index) => index + 1));
    expect(all.at(-1)).toBe(10);
  });

  it("sends stream.resync_required and closes 1000 when the backlog exceeds the replay limit", async () => {
    const handle = await createHelloRun(running.baseUrl, token, FAST_HELLO);
    const live = await connect(handle.run_id);
    await live.waitForType("run.finished");
    mockState.configure({ replayMaxEvents: 3 });

    const resumed = await connect(handle.run_id, { lastSeq: 0 });
    const closed = await resumed.waitForClose();

    expect(resumed.types).toEqual(["stream.hello", "stream.resync_required"]);
    expect(resumed.frames[1]?.payload).toEqual({ reason: "gap_too_large", min_seq: 5 });
    expect(closed.code).toBe(1000);
  });
});

describe("heartbeats and limits", () => {
  it("sends stream.heartbeat on the configured interval", async () => {
    mockState.configure({ heartbeatIntervalMs: 40 });
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const probe = await connect(handle.run_id);

    await probe.waitUntil(
      () => probe.types.filter((type) => type === "stream.heartbeat").length >= 2,
    );

    const heartbeat = probe.frames.find((frame) => frame.type === "stream.heartbeat");
    expect(heartbeat).toMatchObject({ run_id: handle.run_id, seq: null, payload: {} });
    expect(probe.frames[0]?.payload.heartbeat_seconds).toBe(1);
  });

  it("ends the stream after the max age with stream.closing and 4408", async () => {
    mockState.configure({ streamMaxAgeMs: 120 });
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const probe = await connect(handle.run_id);

    const closed = await probe.waitForClose();

    expect(closed.code).toBe(4408);
    expect(probe.frames.at(-1)).toMatchObject({
      type: "stream.closing",
      payload: { reason: "max_age" },
    });
  });

  it("closes 4429 when the user has too many open streams", async () => {
    mockState.configure({ maxConnectionsPerUser: 1 });
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const first = await connect(handle.run_id);
    await first.waitForType("stream.replay_end");

    const second = await connect(handle.run_id);
    const closed = await second.waitForClose();

    expect(closed.code).toBe(4429);
    expect(second.frames).toEqual([]);
  });

  it("frees the slot when a stream closes", async () => {
    mockState.configure({ maxConnectionsPerUser: 1 });
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const first = await connect(handle.run_id);
    await first.waitForType("stream.replay_end");
    first.close();
    await first.waitForClose();

    const second = await connect(handle.run_id);
    await second.waitForType("stream.replay_end");

    expect(second.closed).toBeNull();
    expect(mockState.connections.open).toBe(1);
  });
});

describe("handshake checks", () => {
  it("accepts an allowed origin and a missing origin", async () => {
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const withOrigin = await connect(handle.run_id, { origin: ALLOWED_ORIGIN });
    const withoutOrigin = await connect(handle.run_id);

    await withOrigin.waitForType("stream.replay_end");
    await withoutOrigin.waitForType("stream.replay_end");
  });

  it("closes 4403 for an origin outside the list", async () => {
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const probe = await connect(handle.run_id, { origin: FOREIGN_ORIGIN });

    expect((await probe.waitForClose()).code).toBe(4403);
  });

  it("closes 4401 for a ticket that was already used", async () => {
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const ticket = await requestWsTicket(running.baseUrl, token, handle.run_id);
    const first = openRunSocket(ticket.ws_url);
    openProbes.push(first);
    await first.waitForType("stream.replay_end");

    const replayed = openRunSocket(ticket.ws_url);
    openProbes.push(replayed);

    expect((await replayed.waitForClose()).code).toBe(4401);
  });

  it.each([
    ["missing", (base: string) => base.split("?")[0] ?? base],
    ["tampered", (base: string) => `${base}x`],
    ["not a jwt", (base: string) => `${base.split("?")[0]}?ticket=abc`],
  ])("closes 4401 for a %s ticket", async (_label, mutate) => {
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const ticket = await requestWsTicket(running.baseUrl, token, handle.run_id);
    const probe = openRunSocket(mutate(ticket.ws_url));
    openProbes.push(probe);

    expect((await probe.waitForClose()).code).toBe(4401);
  });

  it("closes 4401 for an expired ticket", async () => {
    mockState.configure({ wsTicketTtlSeconds: -10 });
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const probe = await connect(handle.run_id);

    expect((await probe.waitForClose()).code).toBe(4401);
  });

  it("closes 4401 for a ticket signed with another key", async () => {
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    mockState.configure({ wsTicketSigningKey: "dev-only-other-ticket-signing-key-0123456" });
    const ticket = await requestWsTicket(running.baseUrl, token, handle.run_id);
    mockState.restoreConfig();
    const probe = openRunSocket(ticket.ws_url);
    openProbes.push(probe);

    expect((await probe.waitForClose()).code).toBe(4401);
  });

  it("closes 4403 when the ticket belongs to another run", async () => {
    const first = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const second = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const ticket = await requestWsTicket(running.baseUrl, token, first.run_id);
    const probe = openRunSocket(ticket.ws_url.replace(first.run_id, second.run_id));
    openProbes.push(probe);

    expect((await probe.waitForClose()).code).toBe(4403);
  });

  it("closes 4404 for a run that no longer exists", async () => {
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const ticket = await requestWsTicket(running.baseUrl, token, handle.run_id);
    mockState.runs.clear();
    const probe = openRunSocket(ticket.ws_url);
    openProbes.push(probe);

    expect((await probe.waitForClose()).code).toBe(4404);
  });

  it("closes 4400 for a last_seq that is not a number", async () => {
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const ticket = await requestWsTicket(running.baseUrl, token, handle.run_id);
    const probe = openRunSocket(`${ticket.ws_url}&last_seq=abc`);
    openProbes.push(probe);

    expect((await probe.waitForClose()).code).toBe(4400);
  });

  it("fails the handshake for a path outside /ws/v1/runs/", async () => {
    const probe = openRunSocket(`${running.wsBaseUrl}/ws/v1/other`);
    openProbes.push(probe);

    expect((await probe.waitForClose()).code).toBe(1006);
  });

  it("counts opened and open connections and issued tickets", async () => {
    const openBefore = mockState.connections.open;
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const probe = await connect(handle.run_id);
    await probe.waitForType("stream.replay_end");

    expect(mockState.connections).toEqual({
      opened: 1,
      open: openBefore + 1,
      ticketsIssued: 1,
    });
    probe.close();
    await probe.waitUntil(() => mockState.connections.open === openBefore);
  });
});

describe("client messages", () => {
  it("accepts tile.subscribe and tile.ack", async () => {
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const probe = await connect(handle.run_id);
    await probe.waitForType("stream.replay_end");
    const received: string[] = [];
    const stop = running.hub.onClientMessage((_connection, message) => received.push(message.type));
    const sessionId = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e21";

    probe.send({
      type: "tile.subscribe",
      payload: { tiles: [{ browser_session_id: sessionId, mode: "grid" }] },
    });
    probe.send({ type: "tile.ack", payload: { browser_session_id: sessionId, frame_seq: 4 } });
    await probe.waitUntil(() => received.length === 2);
    stop();

    expect(received).toEqual(["tile.subscribe", "tile.ack"]);
    expect(probe.closed).toBeNull();
  });

  it.each([
    ["an unknown type", { type: "nope", payload: {} }],
    ["a missing payload", { type: "tile.ack" }],
  ])("closes 4400 for %s", async (_label, message) => {
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const probe = await connect(handle.run_id);
    await probe.waitForType("stream.replay_end");

    probe.send(message);

    expect((await probe.waitForClose()).code).toBe(4400);
  });
});

describe("fault ws_close_4413", () => {
  it("closes with stream.closing and 4413 on the next live event, once, and the resume has no gap", async () => {
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const first = await connect(handle.run_id);
    await first.waitForType("stream.replay_end");

    mockState.faults.apply({ ws_close_4413: true });
    const closed = await first.waitForClose();

    expect(closed.code).toBe(4413);
    expect(first.frames.at(-1)).toMatchObject({
      type: "stream.closing",
      payload: { reason: "slow_consumer" },
    });
    expect(mockState.faults.snapshot().ws_close_4413).toBe(0);

    const lastGood = Math.max(...seqs(first.frames));
    const resumed = await connect(handle.run_id, { lastSeq: lastGood });
    await resumed.waitForType("run.finished");

    const all = [...seqs(first.frames), ...seqs(resumed.frames)];
    expect(all).toEqual(Array.from({ length: all.length }, (_, index) => index + 1));
    expect(all.at(-1)).toBe(10);
  });

  it("fires on a socket that is already live even if it was armed before the connection", async () => {
    mockState.faults.apply({ ws_close_4413: true });
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const probe = await connect(handle.run_id);

    expect((await probe.waitForClose()).code).toBe(4413);
  });

  it("supports a count of closes", async () => {
    mockState.faults.apply({ ws_close_4413: 2 });
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);

    const first = await connect(handle.run_id);
    expect((await first.waitForClose()).code).toBe(4413);
    const second = await connect(handle.run_id, { lastSeq: Math.max(0, ...seqs(first.frames)) });
    expect((await second.waitForClose()).code).toBe(4413);
    const third = await connect(handle.run_id, {
      lastSeq: Math.max(0, ...seqs(first.frames), ...seqs(second.frames)),
    });

    await third.waitForType("run.finished");
    expect(mockState.faults.snapshot().ws_close_4413).toBe(0);
  });
});

describe("fault ws_gap", () => {
  it("delivers the next live event with seq plus one, then a clean resume from the last good seq", async () => {
    const handle = await createHelloRun(running.baseUrl, token, LONG_HELLO);
    const first = await connect(handle.run_id);
    await first.waitForType("stream.replay_end");
    const lastGoodBefore = Math.max(...seqs(first.frames));

    mockState.faults.apply({ ws_gap: true });
    await first.waitUntil(() => findGapIndex(seqs(first.frames)) > 0);

    const delivered = seqs(first.frames);
    const gapIndex = findGapIndex(delivered);
    expect(mockState.faults.snapshot().ws_gap).toBe(0);
    const lastGood = delivered[gapIndex - 1] ?? 0;
    expect(lastGood).toBeGreaterThanOrEqual(lastGoodBefore);
    expect(delivered[gapIndex]).toBe(lastGood + 2);
    first.close();

    const resumed = await connect(handle.run_id, { lastSeq: lastGood });
    await resumed.waitForType("run.finished");

    const all = [...delivered.slice(0, gapIndex), ...seqs(resumed.frames)];
    expect(all).toEqual(Array.from({ length: all.length }, (_, index) => index + 1));
    expect(all.at(-1)).toBe(10);
  });

  it("leaves the persisted log untouched", async () => {
    const handle = await createHelloRun(running.baseUrl, token, FAST_HELLO);
    const probe = await connect(handle.run_id);
    await probe.waitForType("stream.replay_end");
    mockState.faults.apply({ ws_gap: true });
    await probe.waitUntil(() => mockState.faults.snapshot().ws_gap === 0);

    const run = mockState.runs.get(handle.run_id);
    expect(run?.events.map((event) => event.seq)).toEqual(
      Array.from({ length: run?.events.length ?? 0 }, (_, index) => index + 1),
    );
  });
});

describe("tokens for other roles", () => {
  it("lets a member user open a stream for their own hello run", async () => {
    const memberToken = await mintApiToken({ user: MEMBER_USER });
    const handle = await createHelloRun(running.baseUrl, memberToken, FAST_HELLO);
    const probe = await connect(handle.run_id, { ticketToken: memberToken });

    await probe.waitForType("run.finished");
  });
});
