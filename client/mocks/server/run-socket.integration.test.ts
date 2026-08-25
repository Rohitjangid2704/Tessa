import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnownStreamEvent } from "@/features/streams/events";
import { parseStreamMessage } from "@/features/streams/events";
import type { RunningMockServer } from "@/mocks/server/http";
import { mockState } from "@/mocks/state";
import {
  RunSocket,
  type ResyncRequest,
  type ResyncResult,
  type RunSocketOptions,
  type RunSocketState,
  type SocketTransport,
} from "@/lib/ws/socket";
import { bearer, mintApiToken } from "@/tests/utils/tokens";
import { createHelloRun, requestWsTicket, startMockApi } from "@/tests/utils/mock-api";

const HELLO_EVENT_COUNT_FOR_THREE_TICKS = 7;
const FAST = { ticks: 3, tick_interval_ms: 100 } as const;
const MEDIUM = { ticks: 4, tick_interval_ms: 150 } as const;
const WAIT_MS = 8000;
const POLL_MS = 10;

vi.setConfig({ testTimeout: 20_000 });

let running: RunningMockServer;
let token: string;
const openSockets: RunSocket[] = [];

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
  for (const socket of openSockets.splice(0)) {
    socket.close();
  }
});

interface Observed {
  socket: RunSocket;
  events: KnownStreamEvent[];
  statuses: RunSocketState["status"][];
  urls: string[];
  persistedSeqs: () => number[];
}

async function fetchEventsAfter(runId: string, afterSeq: number) {
  const response = await fetch(
    `${running.baseUrl}/api/v1/runs/${runId}/events?after_seq=${afterSeq}&limit=200`,
    { headers: bearer(token) },
  );
  return (await response.json()) as { items: unknown[]; head_seq: number; has_more: boolean };
}

async function resyncFromRest(runId: string, request: ResyncRequest): Promise<ResyncResult> {
  const page = await fetchEventsAfter(runId, request.afterSeq);
  let headSeq = request.afterSeq;
  for (const item of page.items) {
    const parsed = parseStreamMessage(item);
    if (parsed.kind === "known") {
      request.apply(parsed.event);
      headSeq = Math.max(headSeq, parsed.event.seq ?? headSeq);
    }
  }
  return { headSeq };
}

function observe(runId: string, overrides: Partial<RunSocketOptions> = {}): Observed {
  const urls: string[] = [];
  const socket = new RunSocket({
    runId,
    requestTicket: (id) => requestWsTicket(running.baseUrl, token, id),
    refreshToken: async () => token,
    resync: (request) => resyncFromRest(runId, request),
    random: () => 0,
    webSocketFactory: (url) => {
      urls.push(url);
      return new WebSocket(url) as unknown as SocketTransport;
    },
    ...overrides,
  });
  const events: KnownStreamEvent[] = [];
  const statuses: RunSocketState["status"][] = [socket.getState().status];
  socket.setListeners({ onEvent: (event) => events.push(event) });
  socket.subscribe(() => {
    const { status } = socket.getState();
    if (statuses.at(-1) !== status) {
      statuses.push(status);
    }
  });
  openSockets.push(socket);
  return {
    socket,
    events,
    statuses,
    urls,
    persistedSeqs: () => events.flatMap((event) => (event.seq === null ? [] : [event.seq])),
  };
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const finished = (observed: Observed) => () =>
  observed.events.some((event) => event.type === "run.finished");

describe("RunSocket against the mock API", () => {
  it("streams the hello run in order with a gap-free seq", async () => {
    const handle = await createHelloRun(running.baseUrl, token, FAST);
    const observed = observe(handle.run_id);
    observed.socket.connect();
    await waitFor(finished(observed), "run.finished");

    expect(observed.persistedSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(
      observed.events.filter((event) => event.seq !== null).map((event) => event.type),
    ).toEqual([
      "run.created",
      "run.status_changed",
      "hello.tick",
      "hello.tick",
      "hello.tick",
      "hello.laya",
      "run.finished",
    ]);
    expect(observed.events[0]?.type).toBe("stream.hello");
    expect(observed.socket.getState()).toMatchObject({
      status: "live",
      lastSeq: HELLO_EVENT_COUNT_FOR_THREE_TICKS,
      replayComplete: true,
      attempt: 0,
      limits: { max_tiles: 12 },
    });
    expect(observed.socket.getState().unknownEventCount).toBe(0);
    expect(observed.socket.getState().invalidMessageCount).toBe(0);
  });

  it("resumes after the initial last_seq and receives only newer events", async () => {
    const handle = await createHelloRun(running.baseUrl, token, FAST);
    await waitFor(
      () => (mockState.runs.get(handle.run_id)?.events.length ?? 0) === 7,
      "the run to finish server side",
    );
    const observed = observe(handle.run_id, { initialLastSeq: 3 });
    observed.socket.connect();
    await waitFor(() => observed.socket.getState().replayComplete, "replay end");

    expect(observed.persistedSeqs()).toEqual([4, 5, 6, 7]);
    expect(observed.urls[0]).toContain("last_seq=3");
  });

  it("goes reconnecting on a 4413 close and resumes with no duplicate or missing seq", async () => {
    const handle = await createHelloRun(running.baseUrl, token, MEDIUM);
    const observed = observe(handle.run_id);
    observed.socket.connect();
    await waitFor(() => observed.socket.getState().status === "live", "the first live state");
    mockState.faults.apply({ ws_close_4413: true });
    await waitFor(finished(observed), "run.finished after the resume");

    expect(observed.statuses).toContain("reconnecting");
    expect(observed.persistedSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(observed.socket.getState()).toMatchObject({ status: "live", gapCount: 0 });
    expect(observed.urls).toHaveLength(2);
    expect(observed.urls[1]).toMatch(/last_seq=\d+/);
  });

  it("detects a skipped seq, drops it and re-requests from the last good seq", async () => {
    const handle = await createHelloRun(running.baseUrl, token, MEDIUM);
    const observed = observe(handle.run_id);
    observed.socket.connect();
    await waitFor(() => observed.socket.getState().status === "live", "the first live state");
    mockState.faults.apply({ ws_gap: true });
    await waitFor(finished(observed), "run.finished after the gap");

    expect(observed.socket.getState().gapCount).toBe(1);
    expect(observed.persistedSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(observed.statuses).toContain("reconnecting");
  });

  it("mints a fresh single-use ticket for every attempt", async () => {
    const handle = await createHelloRun(running.baseUrl, token, MEDIUM);
    const observed = observe(handle.run_id);
    observed.socket.connect();
    await waitFor(() => observed.socket.getState().status === "live", "the first live state");
    mockState.faults.apply({ ws_close_4413: 2 });
    await waitFor(finished(observed), "run.finished after two drops");

    expect(mockState.connections.ticketsIssued).toBe(observed.urls.length);
    expect(new Set(observed.urls.map((url) => new URL(url).searchParams.get("ticket"))).size).toBe(
      observed.urls.length,
    );
    expect(observed.persistedSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("resumes after the server ends a stream at its maximum age (4408)", async () => {
    mockState.configure({ streamMaxAgeMs: 350 });
    const handle = await createHelloRun(running.baseUrl, token, {
      ticks: 6,
      tick_interval_ms: 150,
    });
    const observed = observe(handle.run_id);
    observed.socket.connect();
    await waitFor(finished(observed), "run.finished across max-age closes");

    expect(observed.urls.length).toBeGreaterThanOrEqual(2);
    expect(observed.persistedSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("shows a visible message while the per-user connection cap answers 4429, then recovers", async () => {
    mockState.configure({ maxConnectionsPerUser: 1 });
    const handle = await createHelloRun(running.baseUrl, token, {
      ticks: 8,
      tick_interval_ms: 300,
    });
    const first = observe(handle.run_id);
    first.socket.connect();
    await waitFor(() => first.socket.getState().status === "live", "the first stream");

    const second = observe(handle.run_id);
    second.socket.connect();
    await waitFor(() => second.socket.getState().closeCode === 4429, "the 4429 close");

    expect(second.socket.getState().message).toMatch(/too many live streams/i);
    expect(second.socket.getState().status).toBe("reconnecting");

    first.socket.close();
    await waitFor(() => second.socket.getState().status === "live", "the second stream to recover");
    expect(second.socket.getState().message).toBeNull();
  });

  it("refreshes the token once on 4401 when a ticket is rejected, then connects", async () => {
    const handle = await createHelloRun(running.baseUrl, token, MEDIUM);
    let calls = 0;
    let firstTicketUrl = "";
    let refreshes = 0;
    const observed = observe(handle.run_id, {
      requestTicket: async (id) => {
        calls += 1;
        const ticket = await requestWsTicket(running.baseUrl, token, id);
        if (calls === 1) {
          firstTicketUrl = ticket.ws_url;
        }
        return calls === 2 ? { ws_url: firstTicketUrl } : ticket;
      },
      refreshToken: async () => {
        refreshes += 1;
        return token;
      },
    });
    observed.socket.connect();
    await waitFor(() => observed.socket.getState().status === "live", "the first live state");
    mockState.faults.apply({ ws_close_4413: true });
    await waitFor(finished(observed), "run.finished after the refresh");

    expect(refreshes).toBe(1);
    expect(observed.socket.getState().closeCode).toBeNull();
    expect(observed.persistedSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("refetches over REST on stream.resync_required, then reconnects from the head", async () => {
    mockState.configure({ replayMaxEvents: 2 });
    const handle = await createHelloRun(running.baseUrl, token, FAST);
    await waitFor(
      () => (mockState.runs.get(handle.run_id)?.events.length ?? 0) === 7,
      "the run to finish server side",
    );
    const observed = observe(handle.run_id);
    observed.socket.connect();
    await waitFor(() => observed.socket.getState().replayComplete, "the replay after the resync");

    expect(observed.statuses).toContain("resyncing");
    expect(observed.events.some((event) => event.type === "stream.resync_required")).toBe(true);
    expect(observed.persistedSeqs()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(observed.urls).toHaveLength(2);
    expect(observed.urls[1]).toContain("last_seq=7");
    expect(observed.socket.getState().lastSeq).toBe(7);
  });

  it("fails without retry when the run does not exist", async () => {
    const observed = observe("0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e99", {
      requestTicket: async () => {
        const { ApiError } = await import("@/lib/api/errors");
        throw new ApiError({ status: 404, code: "not_found", message: "Run not found" });
      },
    });
    observed.socket.connect();
    await waitFor(() => observed.socket.getState().status === "failed", "the failed state");

    expect(observed.urls).toHaveLength(0);
  });

  it("stops on the 4404 close of a run that vanished between ticket and connect", async () => {
    const handle = await createHelloRun(running.baseUrl, token, FAST);
    const observed = observe(handle.run_id, {
      requestTicket: async (id) => {
        const ticket = await requestWsTicket(running.baseUrl, token, id);
        mockState.runs.delete(id);
        return ticket;
      },
    });
    observed.socket.connect();
    await waitFor(() => observed.socket.getState().status === "failed", "the failed state");
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(observed.socket.getState()).toMatchObject({ status: "failed", closeCode: 4404 });
    expect(observed.urls).toHaveLength(1);
  });
});
