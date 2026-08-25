import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  launchRun,
  registerAttemptVerdictResolver,
  registerRunScript,
  registerSeedingPhase,
  registerStepRecordedHook,
} from "@/mocks/server/run-simulator";
import type { RunningMockServer } from "@/mocks/server/http";
import { buildConfigSnapshot } from "@/mocks/stage2/plan-service";
import { mockState } from "@/mocks/state";
import { parseStreamMessage } from "@/features/streams/events";
import type { Run, RunScenarioPage } from "@/lib/api/types";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage2Client,
  GRACIE_ID,
  isGapFree,
  seqsOf,
  STAGE_TWO_IDS,
  type Stage2Client,
} from "@/tests/utils/stage2";

type Wire = Record<string, unknown> & {
  type: string;
  seq: number;
  payload: Record<string, unknown>;
};

let running: RunningMockServer;
let client: Stage2Client;
const unregister: Array<() => void> = [];

beforeAll(async () => {
  running = await startMockApi();
  client = createStage2Client(running.baseUrl);
});

afterAll(async () => {
  mockState.reset();
  await running.close();
});

beforeEach(async () => {
  mockState.reset();
  await client.control.clock({ speed: 1000 });
});

afterEach(() => {
  for (const undo of unregister.splice(0)) {
    undo();
  }
  mockState.reset();
});

async function eventsOf(runId: string): Promise<Wire[]> {
  return (await client.getEvents(runId)) as Wire[];
}

function typesOf(events: readonly Wire[]): string[] {
  return events.map((event) => event.type);
}

async function heldPhases(): Promise<Array<{ run_id: string; phase: string }>> {
  const state = (await client.control.state()) as {
    controls: { held: Array<{ run_id: string; phase: string }> };
  };
  return state.controls.held;
}

async function waitUntilHeld(runId: string, phase: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const held = await heldPhases();
    if (held.some((entry) => entry.run_id === runId && entry.phase === phase)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} never reached ${phase}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function signature(events: readonly Wire[]): string[] {
  return events.map((event) => {
    const { payload } = event;
    const detail =
      payload.label ??
      (payload.verdict as { status?: string } | null | undefined)?.status ??
      payload.status ??
      payload.title ??
      "";
    return `${event.type}:${String(detail)}`;
  });
}

describe("run lifecycle events", () => {
  it("emits the documented order with gap-free seq from run.created to run.finished", async () => {
    const handle = await client.startInlineRun({ roles: ["guest", "manager"] });
    const run = await client.runToEnd(handle.run_id);
    expect(run.status).toBe("completed");
    const events = await eventsOf(handle.run_id);

    expect(isGapFree(seqsOf(events))).toBe(true);
    expect(events[0]).toMatchObject({
      type: "run.created",
      seq: 1,
      payload: { kind: "suite", target_id: GRACIE_ID, trigger: "manual", status: "queued" },
    });
    expect(events[1]).toMatchObject({
      type: "run.status_changed",
      payload: { status: "planning", previous: "queued" },
    });
    const queued = events.filter((event) => event.type === "scenario.queued");
    expect(queued).toHaveLength(4);
    const runningAt = events.findIndex(
      (event) => event.type === "run.status_changed" && event.payload.status === "running",
    );
    const lastQueued = events.findLastIndex((event) => event.type === "scenario.queued");
    expect(runningAt).toBeGreaterThan(lastQueued);
    const last = events.at(-1);
    expect(last).toMatchObject({
      type: "run.finished",
      payload: {
        status: "completed",
        counters: run.counters,
        spent_usd: 0,
      },
    });
    expect((last?.payload.duration_ms as number) > 1000).toBe(true);
  });

  it("orders each scenario: queued, started, session, steps, session end, verdict, finished", async () => {
    const handle = await client.startInlineRun({ roles: ["guest"], k: 2 });
    await client.runToEnd(handle.run_id);
    const events = await eventsOf(handle.run_id);
    const scenarioIds = events
      .filter((event) => event.type === "scenario.queued")
      .map((event) => event.payload.run_scenario_id as string);
    expect(scenarioIds).toHaveLength(2);
    for (const id of scenarioIds) {
      const own = events.filter((event) => event.payload.run_scenario_id === id);
      const kinds = own.map((event) => event.type);
      expect(kinds[0]).toBe("scenario.queued");
      expect(kinds.at(-1)).toBe("scenario.finished");
      const started = own.filter((event) => event.type === "scenario.started");
      expect(started.map((event) => event.payload.attempt)).toEqual([0, 1]);
      const verdicts = own.filter((event) => event.type === "scenario.verdict");
      expect(verdicts.map((event) => event.payload.attempt)).toEqual([0, 1]);
      for (const attempt of [0, 1]) {
        const startIndex = own.findIndex(
          (event) => event.type === "scenario.started" && event.payload.attempt === attempt,
        );
        const verdictIndex = own.findIndex(
          (event) => event.type === "scenario.verdict" && event.payload.attempt === attempt,
        );
        const between = own.slice(startIndex + 1, verdictIndex);
        const steps = between.filter((event) => event.type === "step.recorded");
        expect(steps.length).toBeGreaterThan(0);
        expect(steps.map((event) => event.payload.index)).toEqual(
          steps.map((_, position) => position),
        );
        const sessionStart = between.findIndex((event) => event.type === "browser_session.started");
        const sessionEnd = between.findIndex((event) => event.type === "browser_session.ended");
        if (sessionStart >= 0) {
          expect(sessionStart).toBeLessThan(between.findIndex((e) => e.type === "step.recorded"));
          expect(sessionEnd).toBeGreaterThan(
            between.findLastIndex((e) => e.type === "step.recorded"),
          );
        }
      }
    }
    const finished = events.find((event) => event.type === "scenario.finished");
    expect(finished?.payload).toMatchObject({
      status: "finished",
      attempts: { total: 2 },
    });
  });

  it("persists browser sessions and steps behind the events", async () => {
    const handle = await client.startInlineRun({
      feature_ids: ["guest_requests.flow.request_and_track"],
      roles: ["guest"],
      interface_mode: "browser_only",
    });
    await client.runToEnd(handle.run_id);
    const events = await eventsOf(handle.run_id);
    const started = events.find((event) => event.type === "browser_session.started");
    expect(started?.payload).toMatchObject({
      viewport: { width: 1280, height: 800 },
      attempt: 0,
    });
    const sessions = (await (
      await client.get(`/api/v1/runs/${handle.run_id}/browser-sessions`)
    ).json()) as { items: Array<{ id: string; status: string; has_recording: boolean }> };
    expect(sessions.items).toHaveLength(1);
    expect(sessions.items[0]).toMatchObject({
      id: started?.payload.browser_session_id,
      status: "ended",
      has_recording: true,
    });
    const recorded = events.filter((event) => event.type === "step.recorded");
    for (const event of recorded) {
      const response = await client.get(`/api/v1/steps/${event.payload.step_id}`);
      expect(response.status).toBe(200);
    }
    const run = await client.getRun(handle.run_id);
    expect(run.counters.steps_recorded).toBe(recorded.length);
  });

  it("coalesces run.progress and budget.updated to at most one per 2 seconds of run time", async () => {
    const handle = await client.startInlineRun({
      roles: [],
      feature_ids: [],
      area_ids: ["Reports"],
    });
    await client.runToEnd(handle.run_id);
    const events = await eventsOf(handle.run_id);
    const finished = events.find((event) => event.type === "run.finished");
    const durationMs = finished?.payload.duration_ms as number;
    const progress = events.filter((event) => event.type === "run.progress");
    const budget = events.filter((event) => event.type === "budget.updated");
    const limit = Math.floor(durationMs / 2000) + 2;
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.length).toBeLessThanOrEqual(limit);
    expect(budget.length).toBeLessThanOrEqual(limit);
    expect(budget[0]?.payload).toMatchObject({ max_usd: 5, max_minutes: 30, spent_usd: 0 });
    const elapsed = budget.map((event) => event.payload.elapsed_ms as number);
    expect(elapsed).toEqual([...elapsed].sort((left, right) => left - right));
  });

  it("keeps the REST truth ahead of or equal to the streamed counters", async () => {
    const handle = await client.startInlineRun({
      roles: [],
      area_ids: ["Reports"],
      feature_ids: [],
    });
    const run = await client.runToEnd(handle.run_id);
    const events = await eventsOf(handle.run_id);
    const finished = events.at(-1);
    expect(finished?.payload.counters).toEqual(run.counters);
    expect(run.counters.scenarios_done).toBe(run.counters.scenarios_total);
    expect(run.event_head_seq).toBe(events.length);
  });
});

describe("determinism and faults", () => {
  it("yields the same event signature for the same plan and verdict seed", async () => {
    const first = await client.startInlineRun({
      roles: [],
      area_ids: ["Reports"],
      feature_ids: [],
    });
    await client.runToEnd(first.run_id);
    const second = await client.startInlineRun({
      roles: [],
      area_ids: ["Reports"],
      feature_ids: [],
    });
    await client.runToEnd(second.run_id);
    expect(signature(await eventsOf(second.run_id))).toEqual(
      signature(await eventsOf(first.run_id)),
    );
  });

  it("changes outcomes with the verdict seed", async () => {
    const countsFor = async (seed: number) => {
      await client.control.clock({ seed });
      const handle = await client.startInlineRun({
        roles: [],
        feature_ids: [],
        area_ids: ["Account & Access", "Reports", "Streaming & Jobs"],
        interface_mode: "api_only",
      });
      return (await client.runToEnd(handle.run_id)).counters;
    };
    const outcomes: Array<Run["counters"]> = [];
    for (const seed of [1, 2, 3, 4]) {
      outcomes.push(await countsFor(seed));
    }
    expect(new Set(outcomes.map((counters) => counters.fail)).size).toBeGreaterThan(1);
  });

  it("budget_exhausted ends one run with budget.exhausted and budget_exceeded", async () => {
    await client.control.faults({ budget_exhausted: true });
    const handle = await client.startInlineRun({
      roles: [],
      feature_ids: [],
      area_ids: ["Account & Access"],
      interface_mode: "api_only",
      budget: { max_usd: 1, max_minutes: 10 },
    });
    const run = await client.runToEnd(handle.run_id);
    expect(run.status).toBe("budget_exceeded");
    expect(run.budget.spent_usd).toBeGreaterThan(1);
    const events = await eventsOf(handle.run_id);
    const exhausted = events.find((event) => event.type === "budget.exhausted");
    expect(exhausted?.payload).toMatchObject({ dimension: "usd", limit: 1 });
    expect(exhausted?.payload.actual as number).toBeGreaterThan(1);
    expect(events.at(-1)).toMatchObject({
      type: "run.finished",
      payload: { status: "budget_exceeded" },
    });
    const scenarios = (await (
      await client.get(`/api/v1/runs/${handle.run_id}/scenarios?limit=200`)
    ).json()) as RunScenarioPage;
    expect(scenarios.items.some((item) => item.verdict?.skip_reason === "budget_exceeded")).toBe(
      true,
    );
    expect(
      scenarios.items.every((item) => item.status !== "queued" && item.status !== "running"),
    ).toBe(true);

    const next = await client.startInlineRun({ roles: ["guest"] });
    expect((await client.runToEnd(next.run_id)).status).toBe("completed");
  });

  it("verdict_flaky makes scenarios with k above 1 flaky", async () => {
    await client.control.faults({ verdict_flaky: true });
    const handle = await client.startInlineRun({
      roles: [],
      feature_ids: [],
      area_ids: ["Account & Access"],
      interface_mode: "api_only",
      k: 2,
    });
    const run = await client.runToEnd(handle.run_id);
    expect(run.counters.flaky).toBeGreaterThan(0);
    const flaky = (await (
      await client.get(`/api/v1/runs/${handle.run_id}/scenarios?verdict=flaky&limit=200`)
    ).json()) as RunScenarioPage;
    expect(flaky.items).toHaveLength(run.counters.flaky);
    expect(flaky.items[0]?.verdict).toMatchObject({ status: "flaky", tier: "code" });
  });

  it("charges step_cost_usd to the budget when configured", async () => {
    await client.control.clock({ step_cost_usd: 0.01 });
    const handle = await client.startInlineRun({ roles: ["guest"], interface_mode: "api_only" });
    const run = await client.runToEnd(handle.run_id);
    expect(run.counters.steps_recorded).toBeGreaterThan(0);
    expect(run.budget.spent_usd).toBeCloseTo(run.counters.steps_recorded * 0.01, 6);
  });
});

describe("time control: hold, release, pause and advance", () => {
  it("holds a run at running, shows queued scenarios, then releases it", async () => {
    await client.control.hold("running");
    const handle = await client.startInlineRun({ roles: ["guest"] });
    await waitUntilHeld(handle.run_id, "running");
    const run = await client.getRun(handle.run_id);
    expect(run.status).toBe("running");
    expect(run.counters).toMatchObject({
      scenarios_total: 2,
      scenarios_done: 0,
      steps_recorded: 0,
    });
    const scenarios = (await (
      await client.get(`/api/v1/runs/${handle.run_id}/scenarios`)
    ).json()) as RunScenarioPage;
    expect(new Set(scenarios.items.map((item) => item.status))).toEqual(new Set(["queued"]));
    const released = await client.control.release({ phase: "running" });
    expect((await released.json()).released).toBe(1);
    const done = await client.runToEnd(handle.run_id);
    expect(done.status).toBe("completed");
  });

  it("holds at first_step with a live browser session, then at finishing", async () => {
    await client.control.hold("first_step");
    await client.control.hold("finishing");
    const handle = await client.startInlineRun({
      feature_ids: ["guest_requests.flow.request_and_track"],
      roles: ["guest"],
      interface_mode: "browser_only",
    });
    await waitUntilHeld(handle.run_id, "first_step");
    const midway = await client.getRun(handle.run_id);
    expect(midway.counters.steps_recorded).toBe(1);
    const sessions = (await (
      await client.get(`/api/v1/runs/${handle.run_id}/browser-sessions?status=active`)
    ).json()) as { items: unknown[] };
    expect(sessions.items).toHaveLength(1);

    await client.control.release({ phase: "first_step" });
    await client.control.advance({ until_idle: true });
    await waitUntilHeld(handle.run_id, "finishing");
    const final = await client.getRun(handle.run_id);
    expect(final.status).toBe("running");
    expect(final.counters.scenarios_done).toBe(final.counters.scenarios_total);
    expect(typesOf(await eventsOf(handle.run_id))).not.toContain("run.finished");

    await client.control.release();
    await client.control.advance({ until_idle: true });
    expect((await client.getRun(handle.run_id)).status).toBe("completed");
  });

  it("holds a single run by id and leaves other runs flowing", async () => {
    const first = await client.startInlineRun({ roles: ["guest"] });
    await client.control.hold("running", first.run_id);
    await client.control.clock({ paused: true });
    await client.control.advance({ ms: 5000 });
    await waitUntilHeld(first.run_id, "running");
    await client.control.clock({ paused: false });
    const second = await client.startInlineRun({ roles: ["guest"] });
    expect((await client.runToEnd(second.run_id)).status).toBe("completed");
    expect((await client.getRun(first.run_id)).status).toBe("running");
  });

  it("pauses the clock and advances it by virtual milliseconds", async () => {
    await client.control.clock({ speed: 1, paused: true });
    const handle = await client.startInlineRun({ roles: ["guest"] });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await client.getRun(handle.run_id)).status).toBe("queued");
    await client.control.advance({ ms: 1000 });
    const planning = await client.getRun(handle.run_id);
    expect(planning.status).toBe("planning");
    expect(planning.counters.scenarios_total).toBe(2);
    await client.control.advance({ ms: 300 });
    expect((await client.getRun(handle.run_id)).status).toBe("running");
    await client.control.advance({ until_idle: true });
    expect((await client.getRun(handle.run_id)).status).toBe("completed");
  });

  it("paces in real time at speed 1 and speeds up on request", async () => {
    await client.control.clock({ speed: 1 });
    const handle = await client.startInlineRun({ roles: ["guest"], interface_mode: "api_only" });
    const planning = await client.waitForRun(handle.run_id, (run) => run.status === "planning");
    expect(planning.counters.scenarios_total).toBe(0);
    const running = await client.waitForRun(handle.run_id, (run) => run.status === "running");
    expect(running.started_at).not.toBeNull();
    await client.control.clock({ speed: 1000 });
    expect(
      (await client.waitForRun(handle.run_id, (run) => run.status === "completed")).status,
    ).toBe("completed");
  });

  it("resets the clock, holds and runs with the mock reset", async () => {
    await client.control.hold("created");
    await client.control.clock({ speed: 7, seed: 9 });
    await client.startInlineRun();
    const before = (await client.control.state()) as { controls: { holds: unknown[] } };
    expect(before.controls.holds).toHaveLength(1);
    mockState.reset();
    const after = (await client.control.state()) as {
      clock: { speed: number; sleepers: number };
      controls: { holds: unknown[]; seed: number };
      runs: unknown[];
    };
    expect(after.controls).toMatchObject({ holds: [], seed: 1 });
    expect(after.clock).toMatchObject({ speed: 1, sleepers: 0 });
    expect(after.runs).toHaveLength(6);
  });
});

describe("cancel", () => {
  it("cancels a running run: canceling, canceled scenarios and finished counters", async () => {
    await client.control.clock({ speed: 1 });
    await client.control.hold("first_step");
    const handle = await client.startInlineRun({
      roles: [],
      feature_ids: [],
      area_ids: ["Account & Access"],
      interface_mode: "api_only",
    });
    await waitUntilHeld(handle.run_id, "first_step");
    const response = await client.send("POST", `/api/v1/runs/${handle.run_id}/cancel`);
    expect(response.status).toBe(202);
    expect(((await response.json()) as Run).status).toBe("canceling");
    await client.control.clock({ speed: 1000 });
    const run = await client.waitForRun(
      handle.run_id,
      (candidate) => candidate.status === "canceled",
    );
    const events = await eventsOf(handle.run_id);
    expect(isGapFree(seqsOf(events))).toBe(true);
    const statuses = events
      .filter((event) => event.type === "run.status_changed")
      .map((event) => event.payload.status);
    expect(statuses).toEqual(["planning", "running", "canceling"]);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", payload: { status: "canceled" } });
    expect(run.counters.scenarios_done).toBe(run.counters.scenarios_total);
    const scenarios = (await (
      await client.get(`/api/v1/runs/${handle.run_id}/scenarios?limit=200`)
    ).json()) as RunScenarioPage;
    expect(scenarios.items.some((item) => item.status === "canceled")).toBe(true);
    expect(scenarios.items.some((item) => item.status === "skipped")).toBe(true);
    const sessions = await client.get(
      `/api/v1/runs/${handle.run_id}/browser-sessions?status=active`,
    );
    expect(((await sessions.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("cancels a queued run before planning", async () => {
    await client.control.hold("created");
    const handle = await client.startInlineRun();
    const response = await client.send("POST", `/api/v1/runs/${handle.run_id}/cancel`);
    expect(response.status).toBe(202);
    const run = await client.runToEnd(handle.run_id);
    expect(run.status).toBe("canceled");
    expect(run.counters.scenarios_total).toBe(0);
    expect(typesOf(await eventsOf(handle.run_id))).toEqual([
      "run.created",
      "run.status_changed",
      "run.progress",
      "budget.updated",
      "run.finished",
    ]);
  });
});

describe("run socket and replay", () => {
  it("replays persisted events after last_seq, then goes live without gaps", async () => {
    await client.control.hold("running");
    const handle = await client.startInlineRun({ roles: ["guest"] });
    await waitUntilHeld(handle.run_id, "running");
    const head = (await eventsOf(handle.run_id)).length;
    const socket = await client.openRunSocket(handle.run_id, head);
    await socket.waitForType("stream.replay_end");
    expect(socket.frames[0]).toMatchObject({
      type: "stream.hello",
      payload: { resumed_from: head, head_seq: head },
    });
    expect(socket.persisted).toEqual([]);
    await client.control.release();
    await client.control.advance({ until_idle: true });
    await socket.waitUntil(() => socket.types.includes("run.finished"));
    const seqs = socket.persisted.map((frame) => frame.seq as number);
    expect(seqs[0]).toBe(head + 1);
    expect(isGapFree(seqs.map((seq) => seq - head))).toBe(true);
    const all = await eventsOf(handle.run_id);
    expect(seqs.at(-1)).toBe(all.length);
    socket.close();
  });

  it("replays a finished run from any last_seq", async () => {
    const handle = await client.startInlineRun({ roles: ["guest"] });
    await client.runToEnd(handle.run_id);
    const all = await eventsOf(handle.run_id);
    const socket = await client.openRunSocket(handle.run_id, 10);
    await socket.waitForType("stream.replay_end");
    expect(socket.persisted.map((frame) => frame.seq)).toEqual(
      all.slice(10).map((event) => event.seq),
    );
    expect(socket.frames.at(-1)).toMatchObject({
      type: "stream.replay_end",
      payload: { through_seq: all.length },
    });
    socket.close();
    const fresh = await client.openRunSocket(handle.run_id);
    await fresh.waitForType("stream.replay_end");
    expect(fresh.persisted).toHaveLength(all.length);
    fresh.close();
  });

  it("keeps the 4413 and gap faults working on simulated runs", async () => {
    await client.control.hold("running");
    await client.control.faults({ ws_close_4413: true });
    const handle = await client.startInlineRun({ roles: ["guest"] });
    await waitUntilHeld(handle.run_id, "running");
    const socket = await client.openRunSocket(handle.run_id);
    await socket.waitForType("stream.replay_end");
    await client.control.release();
    await client.control.advance({ until_idle: true });
    const closed = await socket.waitForClose();
    expect(closed.code).toBe(4413);
    const lastSeen = Math.max(0, ...socket.persisted.map((frame) => frame.seq as number));
    const resumed = await client.openRunSocket(handle.run_id, lastSeen);
    await resumed.waitForType("stream.replay_end");
    const all = await eventsOf(handle.run_id);
    expect(resumed.persisted.map((frame) => frame.seq)).toEqual(
      all.slice(lastSeen).map((event) => event.seq),
    );
    resumed.close();
  });

  it("streams tile.frame for active browser sessions and honours tile.subscribe", async () => {
    await client.control.clock({ speed: 6 });
    await client.control.hold("first_step");
    const handle = await client.startInlineRun({
      feature_ids: ["guest_requests.flow.request_and_track"],
      roles: ["guest"],
      interface_mode: "browser_only",
    });
    await waitUntilHeld(handle.run_id, "first_step");
    const sessions = (await (
      await client.get(`/api/v1/runs/${handle.run_id}/browser-sessions`)
    ).json()) as { items: Array<{ id: string }> };
    const sessionId = sessions.items[0]?.id as string;
    const socket = await client.openRunSocket(handle.run_id);
    await socket.waitForType("stream.replay_end");
    await client.control.release();
    await socket.waitForType("tile.frame", 8000);
    const frame = socket.frames.find((candidate) => candidate.type === "tile.frame");
    expect(frame).toMatchObject({
      seq: null,
      payload: { browser_session_id: sessionId, mime: "image/jpeg", frame_seq: 1 },
    });
    expect(String(frame?.payload.page_url)).toMatch(/^http/);
    expect(String(frame?.payload.data_b64).length).toBeGreaterThan(1000);

    socket.send({ type: "tile.ack", payload: { browser_session_id: sessionId, frame_seq: 1 } });
    socket.send({ type: "tile.subscribe", payload: { tiles: [] } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const framesAfterUnsubscribe = socket.types.filter((type) => type === "tile.frame").length;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(socket.types.filter((type) => type === "tile.frame").length).toBe(
      framesAfterUnsubscribe,
    );
    expect(socket.closed).toBeNull();
    socket.close();
  });
});

describe("extension points", () => {
  it("lets a step hook add step.graded events and update the step", async () => {
    unregister.push(
      registerStepRecordedHook((context) => {
        const verdict = {
          status: "pass",
          tier: "laya",
          confidence: 0.9,
          reason_code: null,
          reason: null,
          skip_reason: null,
        } as const;
        context.updateStep({ verdict });
        context.emit("step.graded", {
          step_id: context.step.id,
          run_scenario_id: context.runScenarioId,
          verdict,
          escalated_to: null,
        });
      }),
    );
    const handle = await client.startInlineRun({ roles: ["guest"], interface_mode: "api_only" });
    await client.runToEnd(handle.run_id);
    const events = await eventsOf(handle.run_id);
    const graded = events.filter((event) => event.type === "step.graded");
    const recorded = events.filter((event) => event.type === "step.recorded");
    expect(graded).toHaveLength(recorded.length);
    expect(isGapFree(seqsOf(events))).toBe(true);
    const index = events.findIndex((event) => event.type === "step.graded");
    expect(events[index - 1]?.type).toBe("step.recorded");
    const step = (await (
      await client.get(`/api/v1/steps/${graded[0]?.payload.step_id}`)
    ).json()) as {
      verdict: { tier: string };
    };
    expect(step.verdict.tier).toBe("laya");
  });

  it("lets a verdict resolver replace the attempt verdict", async () => {
    unregister.push(
      registerAttemptVerdictResolver((context) => ({
        ...context.defaultVerdict,
        status: "uncertain",
        tier: "judge",
        reason_code: "judge_unsure",
      })),
    );
    const handle = await client.startInlineRun({ roles: ["guest"], interface_mode: "api_only" });
    const run = await client.runToEnd(handle.run_id);
    expect(run.counters.uncertain).toBe(run.counters.scenarios_total);
    const events = await eventsOf(handle.run_id);
    const verdict = events.find((event) => event.type === "scenario.verdict");
    expect(verdict?.payload.verdict).toMatchObject({ status: "uncertain", tier: "judge" });
  });

  it("runs a registered script for another run kind and emits seed.progress", async () => {
    unregister.push(
      registerRunScript("seed", () => ({
        actions: [
          { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
          { atMs: 200, label: "seeding", run: (context) => context.setStatus("seeding") },
          {
            atMs: 400,
            label: "reset started",
            run: (context) =>
              context.emit("seed.progress", {
                phase: "reset",
                status: "started",
                observed_hash: null,
                expected_hash: null,
              }),
          },
          {
            atMs: 900,
            label: "reset ok",
            run: (context) =>
              context.emit("seed.progress", {
                phase: "reset",
                status: "ok",
                observed_hash: "abc",
                expected_hash: "abc",
              }),
          },
          { atMs: 1000, label: "finish", run: (context) => context.finish("completed") },
        ],
      })),
    );
    const entry = launchRun(mockState, mockState.stageTwo, {
      kind: "seed",
      createdBy: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e01",
      targetId: GRACIE_ID,
      planId: null,
      bundleId: null,
      readOnly: false,
      budget: { max_usd: 1, max_minutes: 5 },
      configSnapshot: buildConfigSnapshot(
        mockState.stageOne.latestValidBundle(GRACIE_ID)!,
        new Date().toISOString(),
      ),
    });
    expect(entry.run.workflow_id).toBe(`seed-${entry.run.id}`);
    await client.control.advance({ until_idle: true });
    const run = await client.getRun(entry.run.id);
    expect(run).toMatchObject({ kind: "seed", status: "completed" });
    const events = await eventsOf(entry.run.id);
    expect(typesOf(events)).toEqual([
      "run.created",
      "run.status_changed",
      "seed.progress",
      "seed.progress",
      "run.finished",
    ]);
    const list = (await (await client.get("/api/v1/runs?kind=seed")).json()) as {
      items: unknown[];
    };
    expect(list.items).toHaveLength(1);
  });

  it("inserts a registered seeding phase when reset_seed is true", async () => {
    unregister.push(
      registerSeedingPhase(() => ({
        durationMs: 800,
        actions: [
          {
            atMs: 100,
            label: "hash",
            run: (context) =>
              context.emit("seed.progress", {
                phase: "hash",
                status: "ok",
                observed_hash: "h",
                expected_hash: "h",
              }),
          },
        ],
      })),
    );
    const response = await client.startRun({
      plan: client.planBody({ selection: { roles: ["guest"], interface_mode: "api_only" } }),
      reset_seed: true,
    });
    const handle = (await response.json()) as { run_id: string };
    const run = await client.runToEnd(handle.run_id);
    expect(run.status).toBe("completed");
    const events = await eventsOf(handle.run_id);
    const statuses = events
      .filter((event) => event.type === "run.status_changed")
      .map((event) => event.payload.status);
    expect(statuses).toEqual(["planning", "seeding", "running"]);
    expect(typesOf(events)).toContain("seed.progress");
    const seedAt = events.findIndex((event) => event.type === "seed.progress");
    const runningAt = events.findIndex(
      (event) => event.type === "run.status_changed" && event.payload.status === "running",
    );
    expect(seedAt).toBeLessThan(runningAt);
  });

  it("fails the run when the seeding phase reports a failure", async () => {
    unregister.push(
      registerSeedingPhase(() => ({
        durationMs: 300,
        actions: [],
        failure: { reason: "hash mismatch" },
      })),
    );
    const response = await client.startRun({
      plan: client.planBody({ selection: { roles: ["guest"] } }),
      reset_seed: true,
    });
    const handle = (await response.json()) as { run_id: string };
    const run = await client.runToEnd(handle.run_id);
    expect(run.status).toBe("failed");
    const scenarios = (await (
      await client.get(`/api/v1/runs/${handle.run_id}/scenarios`)
    ).json()) as RunScenarioPage;
    expect(scenarios.items.every((item) => item.verdict?.skip_reason === "seed_mismatch")).toBe(
      true,
    );
  });
});

describe("payloads against the app's zod registry", () => {
  it("parses every persisted event of the seeded and a fresh run as a known event", async () => {
    const fresh = await client.startInlineRun({ roles: ["guest", "manager"], k: 2 });
    await client.runToEnd(fresh.run_id);
    const seededIds = Object.values(STAGE_TWO_IDS.runs).filter(
      (id) => id !== STAGE_TWO_IDS.runs.production,
    );
    const ids = [...seededIds, fresh.run_id];
    const seen = new Set<string>();
    for (const id of ids) {
      for (const event of await eventsOf(id)) {
        const parsed = parseStreamMessage(event);
        expect(parsed, `${id} ${event.type} seq ${event.seq}`).toMatchObject({ kind: "known" });
        seen.add(event.type);
      }
    }
    expect([...seen].sort()).toEqual(
      [
        "browser_session.ended",
        "browser_session.started",
        "budget.exhausted",
        "budget.updated",
        "run.created",
        "run.finished",
        "run.progress",
        "run.status_changed",
        "scenario.finished",
        "scenario.queued",
        "scenario.started",
        "scenario.verdict",
        "step.recorded",
      ].sort(),
    );
  });
});

describe("seeded history", () => {
  it("serves finished event logs for every seeded run, gap-free", async () => {
    for (const id of Object.values(STAGE_TWO_IDS.runs)) {
      if (id === STAGE_TWO_IDS.runs.production) {
        continue;
      }
      const events = await eventsOf(id);
      expect(isGapFree(seqsOf(events)), id).toBe(true);
      expect(events[0]?.type).toBe("run.created");
      expect(events.at(-1)?.type).toBe("run.finished");
    }
  });

  it("makes the event timestamps of seeded runs historical and increasing", async () => {
    const events = await eventsOf(STAGE_TWO_IDS.runs.completed);
    const times = events.map((event) => Date.parse(event.ts as string));
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(times[0]).toBeLessThan(Date.now() - 24 * 3600 * 1000);
  });
});
