import { StrictMode, useState, type ReactNode } from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnownStreamEvent } from "@/features/streams/events";
import { FakeTransport } from "@/tests/utils/fake-socket";
import {
  FIXTURE_RUN_ID,
  helloEnvelope,
  replayEndEnvelope,
  tickEnvelope,
} from "@/tests/utils/stream-fixtures";
import type { UseRunSocketOptions } from "./use-run-socket";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { useRunSocket } = await import("./use-run-socket");

const OTHER_RUN_ID = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e99";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function createHookEnvironment(extra: Partial<UseRunSocketOptions> = {}) {
  const transports: FakeTransport[] = [];
  const events: KnownStreamEvent[] = [];
  const requestTicket = vi.fn(async (runId: string) => ({
    ws_url: `ws://mock.test/ws/v1/runs/${runId}?ticket=t${transports.length}`,
  }));
  const options: UseRunSocketOptions = {
    onEvent: (event) => events.push(event),
    webSocketFactory: (url) => {
      const transport = new FakeTransport(url);
      transports.push(transport);
      return transport;
    },
    dependencies: {
      requestTicket,
      refreshToken: async () => "token",
      resync: async () => ({ headSeq: 0 }),
      random: () => 0.5,
    },
    ...extra,
  };
  return { transports, events, requestTicket, options };
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function strictWrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

describe("useRunSocket", () => {
  it("connects once and exposes the external store state", async () => {
    const { transports, options } = createHookEnvironment();
    const { result } = renderHook(() => useRunSocket(FIXTURE_RUN_ID, options));
    expect(result.current.status).toBe("connecting");
    await flush();

    const [transport] = transports;
    expect(transport).toBeDefined();
    act(() => {
      transport?.open();
      transport?.receive(helloEnvelope());
      transport?.receive(tickEnvelope(1));
    });

    expect(result.current).toMatchObject({ status: "live", lastSeq: 1, attempt: 0 });
    expect(result.current.nextRetryInMs).toBeNull();
  });

  it("opens exactly one socket under a StrictMode double mount and delivers events once", async () => {
    const { transports, events, requestTicket, options } = createHookEnvironment();
    const { result } = renderHook(() => useRunSocket(FIXTURE_RUN_ID, options), {
      wrapper: strictWrapper,
    });
    await flush();

    expect(transports).toHaveLength(1);
    expect(requestTicket.mock.calls.length).toBeGreaterThanOrEqual(1);
    act(() => {
      transports[0]?.open();
      transports[0]?.receive(helloEnvelope());
      transports[0]?.receive(tickEnvelope(1));
      transports[0]?.receive(tickEnvelope(2));
    });

    expect(events.filter((event) => event.seq !== null).map((event) => event.seq)).toEqual([1, 2]);
    expect(result.current.lastSeq).toBe(2);
  });

  it("closes the transport on unmount and does not reconnect", async () => {
    const { transports, options } = createHookEnvironment();
    const { unmount } = renderHook(() => useRunSocket(FIXTURE_RUN_ID, options), {
      wrapper: strictWrapper,
    });
    await flush();
    act(() => transports[0]?.open());

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(transports).toHaveLength(1);
    expect(transports[0]?.closedByClient?.code).toBe(1000);
  });

  it("reports reconnecting with the attempt and delay after a drop", async () => {
    const { transports, options } = createHookEnvironment();
    const { result } = renderHook(() => useRunSocket(FIXTURE_RUN_ID, options));
    await flush();
    act(() => {
      transports[0]?.open();
      transports[0]?.receive(helloEnvelope());
      transports[0]?.receive(replayEndEnvelope(0));
      transports[0]?.serverClose(1006);
    });

    expect(result.current).toMatchObject({
      status: "reconnecting",
      attempt: 1,
      nextRetryInMs: 1000,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(transports).toHaveLength(2);
  });

  it("calls the latest onEvent without reconnecting when the handler changes", async () => {
    const { transports, options } = createHookEnvironment();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ handler }: { handler: (event: KnownStreamEvent) => void }) =>
        useRunSocket(FIXTURE_RUN_ID, { ...options, onEvent: handler }),
      { initialProps: { handler: first } },
    );
    await flush();
    act(() => {
      transports[0]?.open();
      transports[0]?.receive(helloEnvelope());
    });
    expect(first).toHaveBeenCalledTimes(1);

    rerender({ handler: second });
    act(() => {
      transports[0]?.receive(tickEnvelope(1));
    });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(transports).toHaveLength(1);
  });

  it("switches to a new socket when the run id changes and closes the old one", async () => {
    const { transports, options } = createHookEnvironment();
    const { result, rerender } = renderHook(
      ({ runId }: { runId: string | null }) => useRunSocket(runId, options),
      { initialProps: { runId: FIXTURE_RUN_ID as string | null } },
    );
    await flush();
    act(() => {
      transports[0]?.open();
      transports[0]?.receive(helloEnvelope());
      transports[0]?.receive(tickEnvelope(1));
    });
    expect(result.current.lastSeq).toBe(1);

    rerender({ runId: OTHER_RUN_ID });
    await flush();

    expect(transports[0]?.closedByClient).not.toBeNull();
    expect(transports).toHaveLength(2);
    expect(new URL(transports[1]?.url ?? "").pathname).toContain(OTHER_RUN_ID);
    expect(result.current.lastSeq).toBe(0);
  });

  it("stays idle without a run id and opens nothing", async () => {
    const { transports, requestTicket, options } = createHookEnvironment();
    const { result } = renderHook(() => useRunSocket(null, options));
    await flush();

    expect(result.current.status).toBe("idle");
    expect(result.current.send({ type: "tile.subscribe", payload: { tiles: [] } })).toBe(false);
    expect(transports).toHaveLength(0);
    expect(requestTicket).not.toHaveBeenCalled();
  });

  it("does not connect while disabled and connects when enabled", async () => {
    const { transports, options } = createHookEnvironment();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useRunSocket(FIXTURE_RUN_ID, { ...options, enabled }),
      { initialProps: { enabled: false } },
    );
    await flush();
    expect(result.current.status).toBe("idle");
    expect(transports).toHaveLength(0);

    rerender({ enabled: true });
    await flush();
    expect(transports).toHaveLength(1);

    rerender({ enabled: false });
    expect(result.current.status).toBe("closed");
  });

  it("sends client messages through the open transport", async () => {
    const { transports, options } = createHookEnvironment();
    const { result } = renderHook(() => useRunSocket(FIXTURE_RUN_ID, options));
    await flush();
    const message = { type: "tile.subscribe" as const, payload: { tiles: [] } };
    expect(result.current.send(message)).toBe(false);

    act(() => {
      transports[0]?.open();
    });

    expect(result.current.send(message)).toBe(true);
    expect(transports[0]?.sentMessages).toEqual([message]);
  });

  it("starts from initialLastSeq and keeps that value in the first state", async () => {
    const { transports, options } = createHookEnvironment({ initialLastSeq: 6 });
    const { result } = renderHook(() => useRunSocket(FIXTURE_RUN_ID, options));
    expect(result.current.lastSeq).toBe(6);
    await flush();

    expect(transports[0]?.lastSeqParam).toBe("6");
  });

  it("uses the initialLastSeq of the render that first supplies a run id", async () => {
    const { transports, options } = createHookEnvironment();
    const { result, rerender } = renderHook(
      ({ runId, initialLastSeq }: { runId: string | null; initialLastSeq: number }) =>
        useRunSocket(runId, { ...options, initialLastSeq }),
      { initialProps: { runId: null as string | null, initialLastSeq: 0 } },
    );
    await flush();
    expect(transports).toHaveLength(0);

    rerender({ runId: FIXTURE_RUN_ID, initialLastSeq: 17 });
    await flush();

    expect(result.current.lastSeq).toBe(17);
    expect(transports).toHaveLength(1);
    expect(transports[0]?.lastSeqParam).toBe("17");
  });

  it("exposes reconnect from a lower trusted seq and reports skipped sequence numbers", async () => {
    const skipped: number[] = [];
    const { transports, options } = createHookEnvironment({
      onSkipped: (seq) => skipped.push(seq),
    });
    const { result } = renderHook(() => useRunSocket(FIXTURE_RUN_ID, options));
    await flush();
    act(() => {
      transports[0]?.open();
      transports[0]?.receive(helloEnvelope());
      transports[0]?.receive(replayEndEnvelope(0));
      transports[0]?.receive(tickEnvelope(1));
      transports[0]?.receive({
        type: "future.thing",
        run_id: FIXTURE_RUN_ID,
        seq: 2,
        ts: "2026-09-30T14:03:22.123Z",
        payload: {},
      });
    });
    expect(skipped).toEqual([2]);
    expect(result.current.lastSeq).toBe(2);

    let accepted = false;
    act(() => {
      accepted = result.current.reconnect({ lastSeq: 1, message: "A view fell behind" });
    });

    expect(accepted).toBe(true);
    expect(result.current).toMatchObject({ status: "reconnecting", lastSeq: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(transports[1]?.lastSeqParam).toBe("1");
  });

  it("renders from the store inside a component tree", async () => {
    const { transports, options } = createHookEnvironment();
    function Probe() {
      const socket = useRunSocket(FIXTURE_RUN_ID, options);
      const [label] = useState("socket");
      return (
        <p>
          {label} {socket.status} {socket.lastSeq}
        </p>
      );
    }
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    await flush();
    act(() => {
      transports[0]?.open();
      transports[0]?.receive(helloEnvelope());
      transports[0]?.receive(tickEnvelope(1));
    });

    expect(screen.getByText("socket live 1")).toBeInTheDocument();
  });
});
