import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnownStreamEvent } from "@/features/streams/events";
import type { UseRunSocketOptions, UseRunSocketResult } from "@/lib/ws/use-run-socket";
import { createInitialRunSocketState } from "@/lib/ws/socket";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { mockState } from "@/mocks/handlers";
import { signInAs } from "@/tests/utils/api-session";
import { server } from "@/tests/utils/server";
import { act, renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { tickEnvelope, knownEnvelope, FIXTURE_RUN_ID } from "@/tests/utils/stream-fixtures";
import { parseStreamMessage } from "@/features/streams/events";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const socketHarness = vi.hoisted(() => ({
  calls: [] as Array<{ runId: string | null; options: unknown }>,
  state: null as unknown,
}));

vi.mock("@/lib/ws/use-run-socket", () => ({
  useRunSocket: (runId: string | null, options: unknown) => {
    socketHarness.calls.push({ runId, options });
    return socketHarness.state;
  },
}));

const { HelloPlayground } = await import("./hello-playground");

function setSocket(overrides: Partial<UseRunSocketResult> = {}) {
  socketHarness.state = {
    ...createInitialRunSocketState(),
    status: "live",
    send: () => true,
    reconnect: () => true,
    ...overrides,
  } satisfies UseRunSocketResult;
}

function lastOptions(): UseRunSocketOptions {
  const call = socketHarness.calls.at(-1);
  if (call === undefined) {
    throw new Error("the socket hook was never called");
  }
  return call.options as UseRunSocketOptions;
}

function known(wire: ReturnType<typeof tickEnvelope>): KnownStreamEvent {
  const parsed = parseStreamMessage(wire);
  if (parsed.kind !== "known") {
    throw new Error("fixture is not a known event");
  }
  return parsed.event;
}

async function startRun() {
  const button = await screen.findByRole("button", { name: /start hello run/i });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
}

async function startAndStream(): Promise<string> {
  await startRun();
  await waitFor(() =>
    expect(screen.getByTestId("hello-status")).toHaveAttribute("data-phase", "streaming"),
  );
  return screen.getByTestId("hello-run-id").textContent ?? "";
}

beforeEach(async () => {
  socketHarness.calls = [];
  setSocket();
  window.history.replaceState(null, "", "/dev/hello");
  await signInAs(MEMBER_USER);
});

describe("HelloPlayground idle and start failures", () => {
  it("shows the idle state before any run", async () => {
    renderWithProviders(<HelloPlayground />);

    expect(screen.getByTestId("hello-status")).toHaveAttribute("data-phase", "idle");
    expect(screen.getByText("No run yet")).toBeInTheDocument();
    expect(socketHarness.calls).toHaveLength(0);
  });

  it("names the dependency when the API answers 503 dependency_unavailable", async () => {
    mockState.faults.apply({ hello_503: true });
    renderWithProviders(<HelloPlayground />);

    await startRun();

    const alert = await screen.findByTestId("hello-unavailable");
    expect(within(alert).getByText("Temporal is not running")).toBeInTheDocument();
    expect(screen.getByTestId("hello-status")).toHaveAttribute("data-phase", "unavailable");
    expect(window.location.search).toBe("");
    expect(socketHarness.calls).toHaveLength(0);
  });

  it("shows a failure for a server error without claiming a run", async () => {
    server.use(
      http.post("*/api/v1/system/hello-runs", () =>
        HttpResponse.json(
          {
            error: {
              code: "internal_error",
              message: "Unhandled error",
              request_id: "r1",
              details: [],
            },
          },
          { status: 500 },
        ),
      ),
    );
    renderWithProviders(<HelloPlayground />);

    await startRun();

    expect(await screen.findByTestId("hello-failed")).toHaveTextContent("Unhandled error");
    expect(screen.getByTestId("hello-status")).toHaveAttribute("data-phase", "failed");
    expect(screen.queryByTestId("hello-run-id")).not.toBeInTheDocument();
  });

  it("is disabled for a viewer and explains why", async () => {
    await signInAs(VIEWER_USER);
    renderWithProviders(<HelloPlayground />);

    expect(await screen.findByText(/needs the member role/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start hello run/i })).toBeDisabled();
  });

  it("sends the chosen values with an Idempotency-Key", async () => {
    renderWithProviders(<HelloPlayground />);
    const ticks = screen.getByLabelText("Ticks");
    await userEvent.clear(ticks);
    await userEvent.type(ticks, "3");
    await userEvent.click(screen.getByRole("switch", { name: "Include Laya" }));

    await startRun();
    await screen.findByTestId("hello-run-id");

    const run = [...mockState.runs.values()][0];
    expect(run).toBeDefined();
    expect(run?.events.filter((event) => event.type === "hello.laya")).toHaveLength(0);
    expect(mockState.idempotency.size).toBe(1);
  });
});

describe("HelloPlayground with a started run", () => {
  it("writes ?run_id= to the URL, loads the history and passes last_seq to the socket", async () => {
    renderWithProviders(<HelloPlayground />);

    const runId = await startAndStream();

    expect(window.location.search).toBe(`?run_id=${runId}`);
    expect(lastOptions().initialLastSeq).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("run.created")).toBeInTheDocument();
  });

  it("appends streamed events in order and never lists heartbeats", async () => {
    renderWithProviders(<HelloPlayground />);
    await startAndStream();
    const base = lastOptions().initialLastSeq ?? 0;

    act(() => {
      lastOptions().onEvent?.(known(tickEnvelope(base + 1, 3)));
      lastOptions().onEvent?.(known(knownEnvelope("stream.heartbeat", null)));
      lastOptions().onEvent?.(known(tickEnvelope(base + 2, 3)));
    });

    const items = within(screen.getByTestId("hello-events")).getAllByRole("listitem");
    const seqs = items.map((item) => item.getAttribute("data-seq"));
    expect(seqs.slice(-2)).toEqual([String(base + 1), String(base + 2)]);
    expect(items.some((item) => item.getAttribute("data-event-type") === "stream.heartbeat")).toBe(
      false,
    );
  });

  it("shows the finished state, and disables the socket, once run.finished arrives", async () => {
    renderWithProviders(<HelloPlayground />);
    await startAndStream();
    expect(lastOptions().enabled).toBe(true);

    act(() => {
      lastOptions().onEvent?.(
        known(
          knownEnvelope("run.finished", (lastOptions().initialLastSeq ?? 0) + 1, {
            status: "completed",
          }),
        ),
      );
    });

    expect(screen.getByTestId("hello-status")).toHaveAttribute("data-phase", "finished");
    expect(lastOptions().enabled).toBe(false);
  });

  it("shows reconnecting with the attempt and the message", async () => {
    renderWithProviders(<HelloPlayground />);
    await startAndStream();

    setSocket({ status: "reconnecting", attempt: 2, message: "The connection was lost; retrying" });
    act(() => {
      lastOptions().onEvent?.(known(tickEnvelope((lastOptions().initialLastSeq ?? 0) + 1, 3)));
    });

    expect(screen.getByTestId("hello-status")).toHaveAttribute("data-phase", "reconnecting");
    expect(screen.getByText(/attempt 2/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "reconnecting");
  });

  it("shows resyncing, then failed with the socket message", async () => {
    renderWithProviders(<HelloPlayground />);
    await startAndStream();

    setSocket({ status: "resyncing" });
    act(() => {
      lastOptions().onEvent?.(known(tickEnvelope((lastOptions().initialLastSeq ?? 0) + 1, 3)));
    });
    expect(screen.getByTestId("hello-status")).toHaveAttribute("data-phase", "resyncing");

    setSocket({ status: "failed", message: "You do not have access to this stream" });
    act(() => {
      lastOptions().onEvent?.(known(tickEnvelope((lastOptions().initialLastSeq ?? 0) + 2, 3)));
    });
    expect(screen.getByTestId("hello-failed")).toHaveTextContent("You do not have access");
  });
});

describe("HelloPlayground reload with ?run_id=", () => {
  it("loads the event log first, then connects with last_seq of the log", async () => {
    const first = renderWithProviders(<HelloPlayground />);
    const runId = await startAndStream();
    const seen = lastOptions().initialLastSeq ?? 0;
    first.unmount();

    socketHarness.calls = [];
    renderWithProviders(<HelloPlayground initialRunId={runId} />);

    expect(await screen.findByTestId("hello-events")).toBeInTheDocument();
    expect(socketHarness.calls.every((call) => call.runId === runId)).toBe(true);
    expect(lastOptions().initialLastSeq).toBeGreaterThanOrEqual(seen);
    expect(screen.getByText("run.created")).toBeInTheDocument();
  });

  it("shows a failure for a run that does not exist and never opens a socket", async () => {
    renderWithProviders(<HelloPlayground initialRunId={FIXTURE_RUN_ID} />);

    expect(await screen.findByText("This run was not found")).toBeInTheDocument();
    expect(socketHarness.calls).toHaveLength(0);
  });

  it("reaches finished straight from a log that already holds run.finished", async () => {
    const first = renderWithProviders(<HelloPlayground />);
    const runId = await startAndStream();
    first.unmount();
    const run = mockState.runs.get(runId);
    expect(run).toBeDefined();
    if (run !== undefined) {
      mockState.appendEvent(run, "run.finished", {
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
        duration_ms: 1,
      });
    }

    socketHarness.calls = [];
    renderWithProviders(<HelloPlayground initialRunId={runId} />);

    await waitFor(() =>
      expect(screen.getByTestId("hello-status")).toHaveAttribute("data-phase", "finished"),
    );
    expect(lastOptions().enabled).toBe(false);
  });
});
