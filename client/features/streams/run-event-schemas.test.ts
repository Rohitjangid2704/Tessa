import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  BudgetUpdatedPayload,
  ScenarioVerdictPayload,
  SeedProgressPayload,
  StepGradedPayload,
  StepRecordedPayload,
} from "@/lib/api/types";
import {
  FIXTURE_RUN_ID,
  FIXTURE_RUN_SCENARIO_ID,
  FIXTURE_STEP_ID,
  envelope,
  knownEnvelope,
  payloadFixtures,
} from "@/tests/utils/stream-fixtures";
import { describeEvent } from "./describe-event";
import {
  EVENT_REGISTRY,
  EVENT_TYPES,
  LATER_STAGE_EVENT_TYPES,
  RUN_EVENT_TYPES,
  isRunEventType,
  isRunStreamEvent,
  parseStreamMessage,
  skipReasonSchema,
  verdictSchema,
  verdictStatusSchema,
  verdictTierSchema,
  type EventType,
  type LaterStageEventType,
  type KnownStreamEvent,
  type RunEventPayloads,
  type RunEventType,
  type RunStreamEvent,
} from "./events";

const verdict = payloadFixtures["scenario.verdict"].verdict;

function sequenceFor(type: EventType): number | null {
  return EVENT_REGISTRY[type].persistence === "persisted" ? 7 : null;
}

function parseWith(type: EventType, patch: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = { ...payloadFixtures[type] };
  return parseStreamMessage(envelope(type, sequenceFor(type), { ...base, ...patch }));
}

function knownEvent<Type extends EventType>(
  type: Type,
  patch: Partial<(typeof payloadFixtures)[Type]> = {},
): KnownStreamEvent {
  const parsed = parseStreamMessage(knownEnvelope(type, sequenceFor(type), patch));
  if (parsed.kind !== "known") {
    throw new Error(`fixture of ${type} did not parse`);
  }
  return parsed.event;
}

const INVALID_PAYLOADS: ReadonlyArray<
  readonly [LaterStageEventType, string, Record<string, unknown>]
> = [
  ["run.progress", "a negative counter", { scenarios_done: -1 }],
  ["run.progress", "a counter that is not a number", { pass: "two" }],
  ["run.progress", "a missing counter", { steps_recorded: undefined }],
  ["budget.updated", "a negative spend", { spent_usd: -0.01 }],
  ["budget.updated", "a missing time limit", { max_minutes: undefined }],
  ["budget.updated", "a fractional minute limit", { max_minutes: 1.5 }],
  ["budget.exhausted", "an unknown dimension", { dimension: "tokens" }],
  ["budget.exhausted", "a missing limit", { limit: undefined }],
  ["scenario.queued", "a run scenario id that is not a uuid", { run_scenario_id: "rs-1" }],
  ["scenario.queued", "a missing attempts total", { attempts_total: undefined }],
  ["scenario.queued", "a missing title", { title: undefined }],
  ["scenario.started", "a negative attempt", { attempt: -1 }],
  ["scenario.started", "a fractional attempt", { attempt: 0.5 }],
  ["scenario.verdict", "an unknown verdict status", { verdict: { ...verdict, status: "great" } }],
  ["scenario.verdict", "a confidence above 1", { verdict: { ...verdict, confidence: 1.5 } }],
  ["scenario.verdict", "a missing tier", { verdict: { ...verdict, tier: undefined } }],
  ["scenario.verdict", "an unknown skip reason", { verdict: { ...verdict, skip_reason: "nope" } }],
  ["scenario.verdict", "no verdict", { verdict: undefined }],
  ["scenario.finished", "an unknown status", { status: "done" }],
  ["scenario.finished", "attempt counts that are strings", { attempts: { passed: "3" } }],
  ["scenario.finished", "a missing duration", { duration_ms: undefined }],
  ["step.recorded", "an unknown adapter", { adapter: "ftp" }],
  ["step.recorded", "an ok flag that is a string", { ok: "yes" }],
  ["step.recorded", "a fractional index", { index: 1.5 }],
  ["step.recorded", "a missing step id", { step_id: undefined }],
  ["step.graded", "an unknown escalation tier", { escalated_to: "robot" }],
  ["step.graded", "a missing verdict", { verdict: undefined }],
  ["step.graded", "a step id that is not a uuid", { step_id: "step-1" }],
  ["seed.progress", "an unknown phase", { phase: "wipe" }],
  ["seed.progress", "an unknown status", { status: "done" }],
  ["seed.progress", "a missing observed hash", { observed_hash: undefined }],
  ["browser_session.started", "an empty viewport", { viewport: { width: 0, height: 800 } }],
  ["browser_session.started", "a timestamp that is not ISO", { started_at: "yesterday" }],
  ["browser_session.ended", "a recording flag that is a string", { has_recording: "yes" }],
  ["tile.frame", "a mime type other than jpeg", { mime: "image/png" }],
  ["tile.frame", "an empty frame", { data_b64: "" }],
];

describe("stage 2 to 4 event schemas", () => {
  it("registers every contract event of stages 2, 3 and 4", () => {
    expect([...LATER_STAGE_EVENT_TYPES].toSorted()).toEqual(
      [
        "browser_session.ended",
        "browser_session.started",
        "budget.exhausted",
        "budget.updated",
        "run.progress",
        "scenario.finished",
        "scenario.queued",
        "scenario.started",
        "scenario.verdict",
        "seed.progress",
        "step.graded",
        "step.recorded",
        "tile.frame",
      ].toSorted(),
    );
  });

  it("assigns the stage and persistence of the contract catalog", () => {
    expect(EVENT_REGISTRY["run.progress"]).toMatchObject({ stage: 2, persistence: "persisted" });
    expect(EVENT_REGISTRY["budget.updated"]).toMatchObject({ stage: 2, persistence: "persisted" });
    expect(EVENT_REGISTRY["budget.exhausted"]).toMatchObject({
      stage: 2,
      persistence: "persisted",
    });
    expect(EVENT_REGISTRY["scenario.verdict"]).toMatchObject({
      stage: 2,
      persistence: "persisted",
    });
    expect(EVENT_REGISTRY["step.recorded"]).toMatchObject({ stage: 2, persistence: "persisted" });
    expect(EVENT_REGISTRY["tile.frame"]).toMatchObject({ stage: 2, persistence: "ephemeral" });
    expect(EVENT_REGISTRY["seed.progress"]).toMatchObject({ stage: 3, persistence: "persisted" });
    expect(EVENT_REGISTRY["step.graded"]).toMatchObject({ stage: 4, persistence: "persisted" });
  });

  it.each(LATER_STAGE_EVENT_TYPES)("accepts a well formed %s event", (type) => {
    const parsed = parseWith(type);

    expect(parsed.kind).toBe("known");
    if (parsed.kind === "known") {
      expect(parsed.event.type).toBe(type);
      expect(parsed.event.payload).toEqual(payloadFixtures[type]);
    }
  });

  it.each(LATER_STAGE_EVENT_TYPES)("ignores unknown keys of a %s payload", (type) => {
    const parsed = parseWith(type, { surprise: { nested: true } });

    expect(parsed.kind).toBe("known");
    if (parsed.kind === "known") {
      expect(parsed.event.payload).toEqual(payloadFixtures[type]);
      expect(parsed.event.payload).not.toHaveProperty("surprise");
    }
  });

  it.each(
    LATER_STAGE_EVENT_TYPES.filter((type) => EVENT_REGISTRY[type].persistence === "persisted"),
  )("rejects a persisted %s event without a seq", (type) => {
    const parsed = parseStreamMessage(envelope(type, null, { ...payloadFixtures[type] }));

    expect(parsed).toMatchObject({ kind: "invalid", type });
  });

  it("accepts a frame without a seq", () => {
    expect(parseWith("tile.frame").kind).toBe("known");
  });

  it.each(INVALID_PAYLOADS)("rejects %s with %s", (type, _description, patch) => {
    const parsed = parseWith(type, patch);

    expect(parsed).toMatchObject({ kind: "invalid", type, seq: sequenceFor(type) });
  });

  it("rejects an empty payload for every event that has required fields", () => {
    for (const type of LATER_STAGE_EVENT_TYPES) {
      const parsed = parseStreamMessage(envelope(type, sequenceFor(type), {}));
      expect(parsed.kind).toBe("invalid");
    }
  });

  it("keeps null where the contract allows it", () => {
    expect(
      parseWith("scenario.verdict", {
        verdict: { ...verdict, confidence: null, skip_reason: null },
      }).kind,
    ).toBe("known");
    expect(parseWith("scenario.finished", { verdict: null, status: "skipped" }).kind).toBe("known");
    expect(parseWith("step.recorded", { ok: null }).kind).toBe("known");
    expect(parseWith("step.graded", { escalated_to: "judge" }).kind).toBe("known");
    expect(parseWith("seed.progress", { observed_hash: null, expected_hash: null }).kind).toBe(
      "known",
    );
  });

  it("counts a type that is still unregistered as unknown and keeps its seq", () => {
    expect(parseStreamMessage(envelope("finding.created", 21, { finding_id: "f1" }))).toEqual({
      kind: "unknown",
      type: "finding.created",
      seq: 21,
    });
    expect(parseStreamMessage(envelope("scenario.retried", 22))).toEqual({
      kind: "unknown",
      type: "scenario.retried",
      seq: 22,
    });
  });

  it("exposes the verdict enums for filters", () => {
    expect(verdictStatusSchema.options).toEqual(["pass", "fail", "flaky", "uncertain", "skipped"]);
    expect(verdictTierSchema.options).toEqual(["code", "laya", "judge", "human"]);
    expect(skipReasonSchema.options).toHaveLength(12);
    expect(verdictSchema.safeParse(verdict).success).toBe(true);
    expect(verdictSchema.safeParse({ ...verdict, confidence: -0.1 }).success).toBe(false);
  });
});

describe("run event payload types", () => {
  it("maps every run event type to its payload", () => {
    expectTypeOf<RunEventPayloads["budget.updated"]>().toEqualTypeOf<BudgetUpdatedPayload>();
    expectTypeOf<RunEventPayloads["scenario.verdict"]>().toEqualTypeOf<ScenarioVerdictPayload>();
    expectTypeOf<RunEventPayloads["step.recorded"]>().toEqualTypeOf<StepRecordedPayload>();
    expectTypeOf<RunEventPayloads["step.graded"]>().toEqualTypeOf<StepGradedPayload>();
    expectTypeOf<RunEventPayloads["seed.progress"]>().toEqualTypeOf<SeedProgressPayload>();
  });

  it("leaves the stream and hello events out of the run event union", () => {
    expectTypeOf<Extract<RunEventType, `stream.${string}`>>().toBeNever();
    expectTypeOf<Extract<RunEventType, `hello.${string}`>>().toBeNever();
    expectTypeOf<"scenario.finished">().toExtend<RunEventType>();
    expectTypeOf<"run.created">().toExtend<RunEventType>();
    expectTypeOf<RunStreamEvent["type"]>().toEqualTypeOf<RunEventType>();
  });

  it("lists the run event types at runtime", () => {
    expect(RUN_EVENT_TYPES).toContain("run.created");
    expect(RUN_EVENT_TYPES).toContain("scenario.queued");
    expect(RUN_EVENT_TYPES).toContain("seed.progress");
    expect(RUN_EVENT_TYPES).toContain("tile.frame");
    expect(RUN_EVENT_TYPES).not.toContain("stream.hello");
    expect(RUN_EVENT_TYPES).not.toContain("hello.tick");
    expect(RUN_EVENT_TYPES).not.toContain("stream.heartbeat");
    expect(RUN_EVENT_TYPES.length).toBe(EVENT_TYPES.filter(isRunEventType).length);
  });

  it("narrows an event with the run event guard", () => {
    const progress = knownEvent("run.progress");
    const tick = knownEvent("hello.tick");
    const heartbeat = knownEvent("stream.heartbeat");

    expect(isRunStreamEvent(progress)).toBe(true);
    expect(isRunStreamEvent(tick)).toBe(false);
    expect(isRunStreamEvent(heartbeat)).toBe(false);
    if (isRunStreamEvent(progress) && progress.type === "run.progress") {
      expectTypeOf(progress.payload.scenarios_total).toBeNumber();
      expect(progress.payload.scenarios_total).toBe(12);
    }
  });
});

describe("describeEvent for stages 2 to 4", () => {
  it.each(LATER_STAGE_EVENT_TYPES)("describes %s without placeholders", (type) => {
    const description = describeEvent(knownEvent(type));

    expect(description.title.length).toBeGreaterThan(0);
    for (const text of [description.title, description.detail ?? ""]) {
      expect(text).not.toMatch(/undefined|NaN|\[object|null/);
    }
  });

  it("summarises progress and budget in one line", () => {
    expect(describeEvent(knownEvent("run.progress"))).toEqual({
      title: "Progress",
      detail: "3 of 12 scenarios done: 2 pass, 1 fail, 0 flaky, 0 uncertain, 0 skipped",
      tone: "neutral",
    });
    expect(describeEvent(knownEvent("budget.updated"))).toEqual({
      title: "Budget updated",
      detail: "$0.42 of $5.00, 1 min 1 s of 30 min",
      tone: "neutral",
    });
  });

  it("marks an exhausted budget as danger in either dimension", () => {
    expect(describeEvent(knownEvent("budget.exhausted"))).toEqual({
      title: "Budget exhausted",
      detail: "cost limit $5.00, reached $5.01",
      tone: "danger",
    });
    expect(
      describeEvent(
        knownEvent("budget.exhausted", { dimension: "minutes", limit: 30, actual: 30 }),
      ),
    ).toMatchObject({ detail: "time limit 30 min, reached 30 min", tone: "danger" });
  });

  it("describes the scenario lifecycle", () => {
    expect(describeEvent(knownEvent("scenario.queued"))).toEqual({
      title: "Scenario queued",
      detail: "Smart Log read (manager on web), 3 attempts",
      tone: "neutral",
    });
    expect(describeEvent(knownEvent("scenario.queued", { attempts_total: 1 })).detail).toContain(
      "1 attempt",
    );
    expect(describeEvent(knownEvent("scenario.started"))).toEqual({
      title: "Scenario started",
      detail: "attempt 1",
      tone: "info",
    });
    expect(describeEvent(knownEvent("scenario.finished"))).toEqual({
      title: "Scenario finished",
      detail: "verdict pass, 3 of 3 attempts passed, 8400 ms",
      tone: "success",
    });
  });

  it.each([
    ["pass", "success"],
    ["fail", "danger"],
    ["flaky", "warning"],
    ["uncertain", "warning"],
    ["skipped", "neutral"],
  ] as const)("tones a %s verdict as %s and never green unless it passed", (status, tone) => {
    const description = describeEvent(
      knownEvent("scenario.verdict", { verdict: { ...verdict, status } }),
    );

    expect(description.tone).toBe(tone);
    expect(description.title).toBe(`Verdict ${status}`);
    if (status !== "pass") {
      expect(description.tone).not.toBe("success");
    }
  });

  it("shows tier, confidence and skip reason of a verdict", () => {
    const skipped = describeEvent(
      knownEvent("scenario.verdict", {
        verdict: {
          ...verdict,
          status: "skipped",
          tier: "code",
          confidence: null,
          skip_reason: "seed_mismatch",
        },
      }),
    );
    const judged = describeEvent(
      knownEvent("scenario.verdict", {
        run_scenario_id: FIXTURE_RUN_SCENARIO_ID,
        attempt: 2,
        verdict: { ...verdict, tier: "judge", confidence: 0.4 },
      }),
    );

    expect(skipped.detail).toBe("attempt 1, code, seed_mismatch");
    expect(judged.detail).toBe("attempt 3, judge, 40% confidence");
  });

  it.each([
    ["errored", "danger"],
    ["canceled", "warning"],
    ["skipped", "neutral"],
    ["queued", "neutral"],
  ] as const)("tones a scenario that finished %s without a verdict as %s", (status, tone) => {
    const description = describeEvent(knownEvent("scenario.finished", { status, verdict: null }));

    expect(description.tone).toBe(tone);
    expect(description.title).toBe(`Scenario ${status}`);
    expect(description.detail).not.toContain("verdict");
  });

  it("takes the tone of a scenario that finished with a verdict from that verdict", () => {
    expect(
      describeEvent(
        knownEvent("scenario.finished", { verdict: { ...verdict, status: "uncertain" } }),
      ).tone,
    ).toBe("warning");
    expect(
      describeEvent(knownEvent("scenario.finished", { verdict: { ...verdict, status: "fail" } }))
        .tone,
    ).toBe("danger");
  });

  it("describes a recorded step by outcome", () => {
    expect(describeEvent(knownEvent("step.recorded"))).toEqual({
      title: "Step 3 recorded",
      detail: "attempt 1, click Send (browser, ok, 412 ms)",
      tone: "neutral",
    });
    expect(describeEvent(knownEvent("step.recorded", { ok: false }))).toMatchObject({
      detail: "attempt 1, click Send (browser, failed, 412 ms)",
      tone: "danger",
    });
    expect(describeEvent(knownEvent("step.recorded", { ok: null }))).toMatchObject({
      detail: "attempt 1, click Send (browser, no result, 412 ms)",
      tone: "neutral",
    });
    expect(
      describeEvent(knownEvent("step.recorded", { tier0_failure_count: 2, adapter: "http" })),
    ).toMatchObject({
      detail: "attempt 1, click Send (http, ok, 412 ms, 2 tier 0 failures)",
      tone: "warning",
    });
    expect(describeEvent(knownEvent("step.recorded", { tier0_failure_count: 1 })).detail).toContain(
      "1 tier 0 failure)",
    );
  });

  it("describes a graded step and where it was escalated to", () => {
    expect(describeEvent(knownEvent("step.graded"))).toEqual({
      title: "Step graded pass",
      detail: "code, 92% confidence",
      tone: "success",
    });
    expect(
      describeEvent(
        knownEvent("step.graded", {
          step_id: FIXTURE_STEP_ID,
          verdict: { ...verdict, status: "uncertain", tier: "judge", confidence: 0.55 },
          escalated_to: "judge",
        }),
      ),
    ).toEqual({
      title: "Step graded uncertain",
      detail: "judge, 55% confidence, escalated to judge",
      tone: "warning",
    });
  });

  it("describes the seed phases and previews the hashes", () => {
    expect(describeEvent(knownEvent("seed.progress"))).toEqual({
      title: "Seed assert ok",
      detail: "observed 9f2c1d7a6b3e, expected 9f2c1d7a6b3e",
      tone: "success",
    });
    expect(
      describeEvent(
        knownEvent("seed.progress", {
          phase: "hash",
          status: "started",
          observed_hash: null,
          expected_hash: null,
        }),
      ),
    ).toEqual({ title: "Seed hash started", detail: null, tone: "info" });
    expect(
      describeEvent(
        knownEvent("seed.progress", {
          status: "failed",
          observed_hash: "aaaaaaaaaaaaaaaa",
          expected_hash: null,
        }),
      ),
    ).toEqual({
      title: "Seed assert failed",
      detail: "observed aaaaaaaaaaaa, expected none",
      tone: "danger",
    });
  });

  it("describes a session that ended with and without artifacts", () => {
    expect(describeEvent(knownEvent("browser_session.ended")).detail).toBe(
      "recording saved, no trace",
    );
    expect(
      describeEvent(knownEvent("browser_session.ended", { has_recording: false, has_trace: true }))
        .detail,
    ).toBe("no recording, trace saved");
  });

  it.each([
    ["completed", "neutral"],
    ["failed", "danger"],
    ["budget_exceeded", "danger"],
    ["canceled", "warning"],
  ] as const)("never shows a run that finished %s as green", (status, tone) => {
    const description = describeEvent(knownEvent("run.finished", { status }));

    expect(description.tone).toBe(tone);
    expect(description.tone).not.toBe("success");
  });

  it("keeps the run id of the envelope on a parsed event", () => {
    expect(knownEvent("run.progress").run_id).toBe(FIXTURE_RUN_ID);
  });
});
