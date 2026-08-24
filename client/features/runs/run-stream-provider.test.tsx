import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tileSubscribeMessage } from "@/features/streams/events";
import { MEMBER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { FakeTransport } from "@/tests/utils/fake-socket";
import { createTestQueryClient } from "@/tests/utils/render";
import {
  EMPTY_COUNTERS,
  makeBrowserSession,
  makeRun,
  RUN_ID,
  serveRun,
  tickEvents,
} from "@/tests/utils/run-detail-fixtures";
import {
  FIXTURE_SESSION_ID,
  helloEnvelope,
  knownEnvelope,
  replayEndEnvelope,
  tickEnvelope,
} from "@/tests/utils/stream-fixtures";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { RunStreamProvider } = await import("./run-stream-provider");
const { useRunStream, useRunEvents } = await import("./use-run-stream");
const { RunEventStore } = await import("./run-event-store");

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

function createSocketEnvironment() {
  const transports: FakeTransport[] = [];
  const requestTicket = vi.fn(async (runId: string) => ({
    ws_url: `ws://mock.test/ws/v1/runs/${runId}?ticket=t${transports.length + 1}`,
  }));
  return {
    transports,
    requestTicket,
    socketOptions: {
      webSocketFactory: (url: string) => {
        const transport = new FakeTransport(url);
        transports.push(transport);
        return transport;
      },
      dependencies: {
        requestTicket,
        refreshToken: async () => "token",
        random: () => 0.5,
      },
    },
  };
}

type SocketEnvironment = ReturnType<typeof createSocketEnvironment>;

function mountStream(environment: SocketEnvironment, options: { strict?: boolean } = {}) {
  const queryClient = createTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    const tree = (
      <QueryClientProvider client={queryClient}>
        <RunStreamProvider runId={RUN_ID} socketOptions={environment.socketOptions}>
          {children}
        </RunStreamProvider>
      </QueryClientProvider>
    );
    return options.strict ? <StrictMode>{tree}</StrictMode> : tree;
  }
  const rendered = renderHook(() => ({ stream: useRunStream(), log: useRunEvents() }), {
    wrapper: Wrapper,
  });
  return { ...rendered, queryClient };
}

async function ready(result: { current: { stream: { phase: string } } }) {
  await waitFor(() => expect(result.current.stream.phase).toBe("ready"));
}

async function connected(environment: SocketEnvironment, lastSeq: number = 0) {
  await waitFor(() => expect(environment.transports).toHaveLength(1));
  const [transport] = environment.transports;
  if (transport === undefined) {
    throw new Error("no transport");
  }
  act(() => {
    transport.open();
    transport.receive(helloEnvelope(lastSeq === 0 ? null : lastSeq, lastSeq));
    transport.receive(replayEndEnvelope(lastSeq));
  });
  return transport;
}

function seqsOf(result: { current: { log: { events: ReadonlyArray<{ seq: number | null }> } } }) {
  return result.current.log.events.map((event) => event.seq);
}

describe("RunStreamProvider bootstrap", () => {
  it("loads the run, the latest events and the sessions before it asks for a ticket", async () => {
    const { state, requests } = serveRun({
      events: tickEvents(5),
      sessions: [makeBrowserSession()],
    });
    state.run = makeRun({ event_head_seq: 5 });
    const environment = createSocketEnvironment();

    const { result } = mountStream(environment);
    expect(result.current.stream.phase).toBe("loading");
    expect(environment.requestTicket).not.toHaveBeenCalled();
    await ready(result);

    expect(requests.run).toBeGreaterThanOrEqual(1);
    expect(requests.events[0]?.searchParams.get("order")).toBe("desc");
    expect(requests.events[0]?.searchParams.get("limit")).toBe("200");
    expect(requests.sessions).toBe(1);
    expect(result.current.stream.run?.id).toBe(RUN_ID);
    expect(seqsOf(result)).toEqual([1, 2, 3, 4, 5]);
    await waitFor(() => expect(environment.transports).toHaveLength(1));
  });

  it("connects with last_seq equal to the highest loaded seq and goes live", async () => {
    serveRun({ events: tickEvents(5) });
    const environment = createSocketEnvironment();

    const { result } = mountStream(environment);
    await ready(result);
    const transport = await connected(environment, 5);

    expect(transport.lastSeqParam).toBe("5");
    expect(result.current.stream).toMatchObject({
      status: "live",
      lastSeq: 5,
      isLive: true,
      isTerminal: false,
      replayComplete: true,
    });
  });

  it("connects without last_seq when the run has no events yet", async () => {
    serveRun({ run: makeRun({ status: "queued" }), events: [] });
    const environment = createSocketEnvironment();

    const { result } = mountStream(environment);
    await ready(result);
    await waitFor(() => expect(environment.transports).toHaveLength(1));

    expect(environment.transports[0]?.lastSeqParam).toBeNull();
    expect(result.current.stream.lastSeq).toBe(0);
  });

  it("opens no socket and mints no ticket for a run that is already terminal", async () => {
    serveRun({
      run: makeRun({ status: "completed", finished_at: "2026-09-30T14:10:00.000Z" }),
      events: [...tickEvents(3), knownEnvelope("run.finished", 4)],
    });
    const environment = createSocketEnvironment();

    const { result } = mountStream(environment);
    await ready(result);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(environment.transports).toHaveLength(0);
    expect(environment.requestTicket).not.toHaveBeenCalled();
    expect(result.current.stream).toMatchObject({
      status: "idle",
      isTerminal: true,
      isLive: false,
    });
    expect(seqsOf(result)).toEqual([1, 2, 3, 4]);
  });

  it("opens no socket for a terminal run whose log holds no run.finished", async () => {
    serveRun({ run: makeRun({ status: "failed" }), events: tickEvents(2) });
    const environment = createSocketEnvironment();

    const { result } = mountStream(environment);
    await ready(result);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(environment.transports).toHaveLength(0);
    expect(result.current.stream.isTerminal).toBe(true);
  });

  it("treats a run that finished between the two fetches as terminal", async () => {
    serveRun({
      run: makeRun({ status: "running", event_head_seq: 2 }),
      events: [
        ...tickEvents(2),
        knownEnvelope("run.status_changed", 3, { status: "completed", previous: "running" }),
        knownEnvelope("run.finished", 4, { status: "completed" }),
      ],
    });
    const environment = createSocketEnvironment();

    const { result } = mountStream(environment);
    await ready(result);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(result.current.stream.run?.status).toBe("completed");
    expect(result.current.stream.isTerminal).toBe(true);
    expect(environment.transports).toHaveLength(0);
  });

  it("is ready even when the browser sessions request fails", async () => {
    serveRun({ events: tickEvents(2), sessionsFailure: { status: 500 } });
    const environment = createSocketEnvironment();

    const { result } = mountStream(environment);
    await ready(result);

    await waitFor(() => expect(environment.transports).toHaveLength(1));
  });

  it("reports not_found for an unknown run and never connects", async () => {
    serveRun({ run: null });
    const environment = createSocketEnvironment();

    const { result } = mountStream(environment);
    await waitFor(() => expect(result.current.stream.phase).toBe("not_found"));

    expect(environment.requestTicket).not.toHaveBeenCalled();
    expect(result.current.stream.run).toBeUndefined();
  });

  it("reports an error for a failing run request and recovers on retry", async () => {
    const server = serveRun({ runFailure: { status: 500 }, events: tickEvents(2) });
    const environment = createSocketEnvironment();

    const { result } = mountStream(environment);
    await waitFor(() => expect(result.current.stream.phase).toBe("error"), { timeout: 8000 });
    expect(environment.requestTicket).not.toHaveBeenCalled();

    server.state.runFailure = null;
    act(() => result.current.stream.retry());
    await ready(result);

    await waitFor(() => expect(environment.transports).toHaveLength(1));
  }, 15_000);

  it("reports an error when the event history cannot be loaded", async () => {
    serveRun({ eventsFailure: { status: 500 } });
    const environment = createSocketEnvironment();

    const { result } = mountStream(environment);

    await waitFor(() => expect(result.current.stream.phase).toBe("error"), { timeout: 8000 });
    expect(environment.requestTicket).not.toHaveBeenCalled();
  }, 15_000);
});

describe("RunStreamProvider StrictMode", () => {
  it("opens one socket and asks for one ticket under a double mount", async () => {
    serveRun({ events: tickEvents(3) });
    const environment = createSocketEnvironment();

    const { result } = mountStream(environment, { strict: true });
    await ready(result);
    const transport = await connected(environment, 3);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(environment.transports).toHaveLength(1);
    expect(environment.requestTicket).toHaveBeenCalledTimes(1);
    expect(transport.lastSeqParam).toBe("3");
    act(() => {
      transport.receive(tickEnvelope(4));
    });
    expect(seqsOf(result)).toEqual([1, 2, 3, 4]);
  });

  it("closes the socket on unmount and does not reconnect", async () => {
    serveRun({ events: tickEvents(3) });
    const environment = createSocketEnvironment();
    const { result, unmount } = mountStream(environment, { strict: true });
    await ready(result);
    const transport = await connected(environment, 3);

    unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1300));
    });

    expect(transport.closedByClient?.code).toBe(1000);
    expect(environment.transports).toHaveLength(1);
  });
});

describe("RunStreamProvider live events", () => {
  it("appends live events to the log and patches the cached run", async () => {
    serveRun({ events: tickEvents(2) });
    const environment = createSocketEnvironment();
    const { result, queryClient } = mountStream(environment);
    await ready(result);
    const transport = await connected(environment, 2);

    act(() => {
      transport.receive(
        knownEnvelope("run.progress", 3, { ...EMPTY_COUNTERS, scenarios_total: 4, pass: 2 }),
      );
      transport.receive(
        knownEnvelope("budget.updated", 4, {
          max_usd: 5,
          spent_usd: 0.75,
          max_minutes: 30,
          elapsed_ms: 12_000,
        }),
      );
    });

    expect(seqsOf(result)).toEqual([1, 2, 3, 4]);
    expect(result.current.stream.lastSeq).toBe(4);
    expect(result.current.stream.run).toMatchObject({
      counters: { pass: 2 },
      budget: { spent_usd: 0.75 },
    });
    expect(queryClient.getQueryData(["runs", RUN_ID, "detail"])).toBeDefined();
  });

  it("hands frames to the frame bus and keeps them out of the log", async () => {
    serveRun({ events: tickEvents(1) });
    const environment = createSocketEnvironment();
    const { result } = mountStream(environment);
    await ready(result);
    const transport = await connected(environment, 1);
    const publish = vi.spyOn(result.current.stream.frameBus, "publish");

    act(() => {
      transport.receive(
        knownEnvelope("tile.frame", null, { browser_session_id: FIXTURE_SESSION_ID }),
      );
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(seqsOf(result)).toEqual([1]);
  });

  it("keeps stream events in the debug list only", async () => {
    serveRun({ events: tickEvents(1) });
    const environment = createSocketEnvironment();
    const { result } = mountStream(environment);
    await ready(result);
    await connected(environment, 1);

    expect(seqsOf(result)).toEqual([1]);
    expect(result.current.log.streamEvents.map((event) => event.type)).toEqual([
      "stream.hello",
      "stream.replay_end",
    ]);
  });

  it("sends client messages through the open socket", async () => {
    serveRun({ events: tickEvents(1) });
    const environment = createSocketEnvironment();
    const { result } = mountStream(environment);
    await ready(result);
    const transport = await connected(environment, 1);
    const message = tileSubscribeMessage([
      { browser_session_id: FIXTURE_SESSION_ID, mode: "grid" },
    ]);

    let sent = false;
    act(() => {
      sent = result.current.stream.send(message);
    });

    expect(sent).toBe(true);
    expect(transport.sentMessages).toContainEqual(message);
  });

  it("closes the socket on run.finished and refetches the run, scenarios and sessions", async () => {
    const server = serveRun({ events: tickEvents(2) });
    const environment = createSocketEnvironment();
    const { result } = mountStream(environment);
    await ready(result);
    const transport = await connected(environment, 2);
    const runRequestsBefore = server.requests.run;
    const sessionRequestsBefore = server.requests.sessions;
    server.state.run = makeRun({
      status: "completed",
      finished_at: "2026-09-30T14:10:00.000Z",
      event_head_seq: 3,
    });

    act(() => {
      transport.receive(knownEnvelope("run.finished", 3, { status: "completed" }));
    });

    await waitFor(() => expect(transport.closedByClient?.code).toBe(1000));
    await waitFor(() => expect(server.requests.run).toBeGreaterThan(runRequestsBefore));
    await waitFor(() => expect(server.requests.sessions).toBeGreaterThan(sessionRequestsBefore));
    expect(result.current.stream).toMatchObject({ isTerminal: true, isLive: false });
    expect(result.current.stream.status).toBe("closed");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1300));
    });
    expect(environment.transports).toHaveLength(1);
  });
});

describe("RunStreamProvider reconnect and resync", () => {
  it("resumes after a dropped connection from the latest seq without duplicates or holes", async () => {
    serveRun({ events: tickEvents(2) });
    const environment = createSocketEnvironment();
    const { result } = mountStream(environment);
    await ready(result);
    const first = await connected(environment, 2);
    act(() => {
      first.receive(tickEnvelope(3));
      first.receive(tickEnvelope(4));
    });

    act(() => first.serverClose(1006));
    await waitFor(() => expect(result.current.stream.status).toBe("reconnecting"));
    expect(result.current.stream).toMatchObject({ attempt: 1, nextRetryInMs: 1000 });

    await waitFor(() => expect(environment.transports).toHaveLength(2), { timeout: 3000 });
    const second = environment.transports[1];
    expect(second?.lastSeqParam).toBe("4");
    act(() => {
      second?.open();
      second?.receive(helloEnvelope(4, 6));
      second?.receive(tickEnvelope(4));
      second?.receive(tickEnvelope(5));
      second?.receive(tickEnvelope(6));
      second?.receive(replayEndEnvelope(6));
    });

    expect(seqsOf(result)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.current.stream).toMatchObject({ status: "live", lastSeq: 6 });
    expect(environment.requestTicket).toHaveBeenCalledTimes(2);
  });

  it("reconnects from the last good seq when the stream skips ahead", async () => {
    serveRun({ events: tickEvents(2) });
    const environment = createSocketEnvironment();
    const { result } = mountStream(environment);
    await ready(result);
    const first = await connected(environment, 2);

    act(() => {
      first.receive(tickEnvelope(3));
      first.receive(tickEnvelope(5));
    });

    expect(seqsOf(result)).toEqual([1, 2, 3]);
    await waitFor(() => expect(environment.transports).toHaveLength(2), { timeout: 3000 });
    expect(environment.transports[1]?.lastSeqParam).toBe("3");
    const second = environment.transports[1];
    act(() => {
      second?.open();
      second?.receive(helloEnvelope(3, 5));
      second?.receive(tickEnvelope(4));
      second?.receive(tickEnvelope(5));
      second?.receive(replayEndEnvelope(5));
    });
    expect(seqsOf(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reconnects from the ledger when the log itself reports a gap", async () => {
    serveRun({ events: tickEvents(2) });
    const environment = createSocketEnvironment();
    const { result } = mountStream(environment);
    await ready(result);
    const first = await connected(environment, 2);
    const store = result.current.stream.events;
    if (!(store instanceof RunEventStore)) {
      throw new Error("the provider hands out its RunEventStore");
    }

    act(() => {
      store.append({ ...store.getSnapshot().events[0]!, seq: 9 });
    });

    await waitFor(() => expect(result.current.stream.status).toBe("reconnecting"));
    expect(first.closedByClient?.code).toBe(1000);
    expect(result.current.stream.lastSeq).toBe(2);
    expect(result.current.log.gap).toBeNull();
    await waitFor(() => expect(environment.transports).toHaveLength(2), { timeout: 3000 });
    expect(environment.transports[1]?.lastSeqParam).toBe("2");
  });

  it("reloads the latest events and reconnects after stream.resync_required", async () => {
    const server = serveRun({ events: tickEvents(2) });
    const environment = createSocketEnvironment();
    const { result } = mountStream(environment);
    await ready(result);
    const first = await connected(environment, 2);
    const eventRequestsBefore = server.requests.events.length;
    server.state.events = tickEvents(30);

    act(() => {
      first.receive(
        knownEnvelope("stream.resync_required", null, { reason: "gap_too_large", min_seq: 10 }),
      );
    });
    expect(result.current.stream.status).toBe("resyncing");

    await waitFor(() => expect(server.requests.events.length).toBeGreaterThan(eventRequestsBefore));
    await waitFor(() => expect(environment.transports).toHaveLength(2), { timeout: 3000 });
    expect(environment.transports[1]?.lastSeqParam).toBe("30");
    expect(seqsOf(result)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(result.current.log.lastSeq).toBe(30);
  });
});

describe("RunStreamProvider older events", () => {
  it("pages older events in with loadOlder", async () => {
    const server = serveRun({ events: tickEvents(250) });
    const environment = createSocketEnvironment();
    const { result } = mountStream(environment);
    await ready(result);
    expect(result.current.log).toMatchObject({ lowestSeq: 51, hasOlder: true });
    expect(seqsOf(result)).toHaveLength(200);

    await act(async () => {
      await result.current.stream.events.loadOlder();
    });

    expect(server.requests.events.at(-1)?.searchParams.get("before_seq")).toBe("51");
    expect(seqsOf(result)).toHaveLength(250);
    expect(result.current.log).toMatchObject({ lowestSeq: 1, hasOlder: false });
  });
});
