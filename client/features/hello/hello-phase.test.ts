import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import type { KnownStreamEvent } from "@/features/streams/events";
import {
  deriveHelloPhase,
  findFinishedStatus,
  phaseLiveState,
  phaseTitle,
  type HelloPhase,
  type HelloPhaseInput,
} from "./hello-phase";

function input(overrides: Partial<HelloPhaseInput> = {}): HelloPhaseInput {
  return {
    runId: "run-1",
    startPending: false,
    startError: null,
    historyPending: false,
    historyError: null,
    socketStatus: "live",
    socketMessage: null,
    socketAttempt: 0,
    finishedStatus: null,
    ...overrides,
  };
}

const temporalDown = new ApiError({
  status: 503,
  code: "dependency_unavailable",
  message: "Temporal is not running",
  details: [{ loc: ["dependency"], code: "temporal", message: "unreachable" }],
});

describe("deriveHelloPhase", () => {
  it("is idle without a run", () => {
    expect(deriveHelloPhase(input({ runId: null, socketStatus: null }))).toEqual({ kind: "idle" });
  });

  it("is starting while the start request is pending", () => {
    expect(deriveHelloPhase(input({ runId: null, startPending: true }))).toEqual({
      kind: "starting",
    });
  });

  it("names the dependency of a 503 dependency_unavailable", () => {
    expect(deriveHelloPhase(input({ runId: null, startError: temporalDown }))).toEqual({
      kind: "unavailable",
      dependency: "temporal",
      message: "Temporal is not running",
    });
  });

  it("keeps an unavailable phase for a 503 whose dependency is unknown", () => {
    const unknown = new ApiError({
      status: 503,
      code: "dependency_unavailable",
      message: "down",
      details: [],
    });

    expect(deriveHelloPhase(input({ runId: null, startError: unknown }))).toMatchObject({
      kind: "unavailable",
      dependency: null,
    });
  });

  it("reports other start errors as failed with the API message", () => {
    const rateLimited = new ApiError({ status: 429, code: "rate_limited", message: "slow" });

    expect(deriveHelloPhase(input({ runId: null, startError: rateLimited }))).toEqual({
      kind: "failed",
      message: "Too many requests. Try again shortly.",
    });
    expect(deriveHelloPhase(input({ runId: null, startError: new Error("boom") }))).toEqual({
      kind: "failed",
      message: "boom",
    });
  });

  it("is connecting while the history loads", () => {
    expect(deriveHelloPhase(input({ historyPending: true, socketStatus: null }))).toEqual({
      kind: "connecting",
      detail: "Loading the event log",
    });
  });

  it("fails with a clear message when the run is not found", () => {
    const missing = new ApiError({ status: 404, code: "not_found", message: "nope" });

    expect(deriveHelloPhase(input({ historyError: missing, socketStatus: null }))).toEqual({
      kind: "failed",
      message: "This run was not found",
    });
  });

  it.each([
    ["live", { kind: "streaming" }],
    ["resyncing", { kind: "resyncing" }],
  ] as const)("maps the %s socket", (socketStatus, expected) => {
    expect(deriveHelloPhase(input({ socketStatus }))).toEqual(expected);
  });

  it("carries the attempt and message while reconnecting", () => {
    expect(
      deriveHelloPhase(
        input({ socketStatus: "reconnecting", socketAttempt: 2, socketMessage: "Resuming" }),
      ),
    ).toEqual({ kind: "reconnecting", attempt: 2, detail: "Resuming" });
  });

  it("fails when the socket fails and shows its message", () => {
    expect(
      deriveHelloPhase(input({ socketStatus: "failed", socketMessage: "This run was not found" })),
    ).toEqual({ kind: "failed", message: "This run was not found" });
  });

  it.each(["connecting", "closed", "idle"] as const)("is connecting for a %s socket", (status) => {
    expect(deriveHelloPhase(input({ socketStatus: status })).kind).toBe("connecting");
  });

  it("is finished when run.finished arrived, whatever the socket says", () => {
    expect(
      deriveHelloPhase(input({ finishedStatus: "completed", socketStatus: "closed" })),
    ).toEqual({ kind: "finished" });
  });

  it.each(["failed", "canceled", "budget_exceeded"])(
    "treats a run that finished %s as failed",
    (status) => {
      expect(deriveHelloPhase(input({ finishedStatus: status })).kind).toBe("failed");
    },
  );

  it("lets a pending start win over everything else", () => {
    expect(deriveHelloPhase(input({ startPending: true, finishedStatus: "completed" })).kind).toBe(
      "starting",
    );
  });
});

describe("phaseLiveState and phaseTitle", () => {
  const phases: Array<[HelloPhase, string, string]> = [
    [{ kind: "idle" }, "closed", "No run yet"],
    [{ kind: "starting" }, "reconnecting", "Starting the run"],
    [{ kind: "connecting", detail: "x" }, "reconnecting", "Connecting"],
    [{ kind: "streaming" }, "live", "Streaming"],
    [{ kind: "reconnecting", attempt: 1, detail: "x" }, "reconnecting", "Reconnecting"],
    [{ kind: "resyncing" }, "reconnecting", "Resyncing"],
    [{ kind: "finished" }, "closed", "Finished"],
    [{ kind: "failed", message: "x" }, "error", "Failed"],
    [
      { kind: "unavailable", dependency: "temporal", message: "x" },
      "error",
      "Cannot start the run",
    ],
  ];

  it.each(phases)("maps %j", (phase, live, title) => {
    expect(phaseLiveState(phase, null)).toBe(live);
    expect(phaseTitle(phase)).toBe(title);
  });
});

describe("findFinishedStatus", () => {
  const tick = {
    type: "hello.tick",
    run_id: "r",
    seq: 1,
    ts: "2026-09-30T14:03:22.123Z",
    payload: { n: 1, total: 1, message: "m" },
  } satisfies KnownStreamEvent;

  it("returns the status of run.finished and null when there is none", () => {
    const finished = {
      type: "run.finished",
      run_id: "r",
      seq: 2,
      ts: "2026-09-30T14:03:22.123Z",
      payload: {
        status: "completed",
        spent_usd: 0,
        duration_ms: 1,
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
      },
    } satisfies KnownStreamEvent;

    expect(findFinishedStatus([tick])).toBeNull();
    expect(findFinishedStatus([tick, finished])).toBe("completed");
  });
});
