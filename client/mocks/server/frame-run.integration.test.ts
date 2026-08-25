import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseStreamMessage } from "@/features/streams/events";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import {
  openRunSocket,
  postJson,
  requestWsTicket,
  type ReceivedFrame,
  type SocketProbe,
} from "@/tests/utils/mock-api";
import { bearer, mintApiToken } from "@/tests/utils/tokens";
import { startMockApi } from "@/tests/utils/mock-api";

interface FrameRunResponse {
  run_id: string;
  sessions: Array<{ id: string; title: string }>;
}

let running: RunningMockServer;
let token: string;
const probes: SocketProbe[] = [];

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
  for (const probe of probes.splice(0)) {
    probe.close();
  }
});

async function createFrameRun(sessions?: number): Promise<FrameRunResponse> {
  const response = await postJson(
    running.baseUrl,
    "/__mock/frame-runs",
    sessions === undefined ? {} : { sessions },
    bearer(token),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as FrameRunResponse;
}

async function connect(runId: string): Promise<SocketProbe> {
  const ticket = await requestWsTicket(running.baseUrl, token, runId);
  const probe = openRunSocket(ticket.ws_url);
  probes.push(probe);
  return probe;
}

function framesOf(probe: SocketProbe, sessionId?: string): ReceivedFrame[] {
  return probe.frames.filter(
    (frame) =>
      frame.type === "tile.frame" &&
      (sessionId === undefined || frame.payload.browser_session_id === sessionId),
  );
}

function ackAll(probe: SocketProbe): void {
  const newest = new Map<string, number>();
  for (const frame of framesOf(probe)) {
    newest.set(String(frame.payload.browser_session_id), Number(frame.payload.frame_seq));
  }
  for (const [sessionId, frameSeq] of newest) {
    probe.send({
      type: "tile.ack",
      payload: { browser_session_id: sessionId, frame_seq: frameSeq },
    });
  }
}

describe("frame run", () => {
  it("creates a run with 12 sessions announced by persisted browser_session.started events", async () => {
    const created = await createFrameRun();

    expect(created.sessions).toHaveLength(12);
    const run = mockState.runs.get(created.run_id);
    expect(run?.events.map((event) => event.type)).toEqual([
      "run.created",
      "run.status_changed",
      ...Array.from({ length: 12 }, () => "browser_session.started"),
    ]);
    expect(run?.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1),
    );
    const parsed = parseStreamMessage(run?.events[2]);
    expect(parsed.kind).toBe("known");
  });

  it("validates the session count and requires a token", async () => {
    const tooMany = await postJson(
      running.baseUrl,
      "/__mock/frame-runs",
      { sessions: 99 },
      bearer(token),
    );
    const anonymous = await postJson(running.baseUrl, "/__mock/frame-runs", {});

    expect(tooMany.status).toBe(422);
    expect(anonymous.status).toBe(401);
  });

  it("streams tile.frame envelopes of about 80 KB through the real WebSocket as JSON text", async () => {
    const created = await createFrameRun(2);
    const probe = await connect(created.run_id);
    await probe.waitUntil(() => framesOf(probe).length >= 2, 10_000);

    const frame = framesOf(probe)[0];
    expect(frame).toMatchObject({ type: "tile.frame", run_id: created.run_id, seq: null });
    const parsed = parseStreamMessage(frame);
    expect(parsed.kind).toBe("known");
    const payload = frame?.payload as { data_b64: string; width: number; height: number };
    expect(payload.width).toBe(640);
    expect(payload.height).toBe(400);
    expect(payload.data_b64.length).toBeGreaterThan(70_000);
    expect(payload.data_b64.length).toBeLessThan(100_000);
  });

  it("starts frames only after stream.replay_end and keeps persisted seq gap free", async () => {
    const created = await createFrameRun(2);
    const probe = await connect(created.run_id);
    await probe.waitUntil(() => framesOf(probe).length >= 1, 10_000);

    const replayEndIndex = probe.types.indexOf("stream.replay_end");
    const firstFrameIndex = probe.types.indexOf("tile.frame");
    expect(replayEndIndex).toBeGreaterThan(0);
    expect(firstFrameIndex).toBeGreaterThan(replayEndIndex);
    expect(probe.persisted.map((frame) => frame.seq)).toEqual(
      Array.from({ length: 4 }, (_, index) => index + 1),
    );
  });

  it("stops at 2 unacked frames per tile and continues after a cumulative ack", async () => {
    const created = await createFrameRun(1);
    const probe = await connect(created.run_id);
    await probe.waitUntil(() => framesOf(probe).length >= 2, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(framesOf(probe)).toHaveLength(2);

    ackAll(probe);
    await probe.waitUntil(() => framesOf(probe).length >= 3, 5000);

    const seqs = framesOf(probe).map((frame) => Number(frame.payload.frame_seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("honours tile.subscribe: only the listed tile keeps receiving frames", async () => {
    const created = await createFrameRun(3);
    const probe = await connect(created.run_id);
    await probe.waitUntil(() => framesOf(probe).length >= 3, 10_000);

    const [, second] = created.sessions as [unknown, { id: string }, unknown];
    probe.send({
      type: "tile.subscribe",
      payload: { tiles: [{ browser_session_id: second.id, mode: "grid" }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    ackAll(probe);
    const before = framesOf(probe).length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const markerIndex = probe.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    ackAll(probe);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const later = probe.frames.slice(markerIndex).filter((frame) => frame.type === "tile.frame");
    expect(framesOf(probe).length).toBeGreaterThan(before);
    expect(later.length).toBeGreaterThan(0);
    for (const frame of later) {
      expect(frame.payload.browser_session_id).toBe(second.id);
    }
  });

  it("closes 4400 for an invalid tile.subscribe on a frame run", async () => {
    const created = await createFrameRun(1);
    const probe = await connect(created.run_id);
    await probe.waitForType("stream.replay_end");

    probe.send({
      type: "tile.subscribe",
      payload: { tiles: [{ browser_session_id: "not-a-uuid", mode: "grid" }] },
    });

    expect((await probe.waitForClose()).code).toBe(4400);
  });

  it("stops streaming when the socket closes", async () => {
    const created = await createFrameRun(2);
    const probe = await connect(created.run_id);
    await probe.waitUntil(() => framesOf(probe).length >= 1, 10_000);
    expect(mockState.frameStreamers.size).toBe(1);

    probe.close();
    await probe.waitForClose();
    await probe.waitUntil(() => mockState.frameStreamers.size === 0, 3000);
  });

  it("keeps frames out of the replayed event log", async () => {
    const created = await createFrameRun(2);
    const probe = await connect(created.run_id);
    await probe.waitUntil(() => framesOf(probe).length >= 1, 10_000);

    const page = await fetch(`${running.baseUrl}/api/v1/runs/${created.run_id}/events?limit=50`, {
      headers: bearer(token),
    });
    const body = (await page.json()) as { items: Array<{ type: string }> };

    expect(body.items.some((item) => item.type === "tile.frame")).toBe(false);
    expect(body.items).toHaveLength(4);
  });
});
