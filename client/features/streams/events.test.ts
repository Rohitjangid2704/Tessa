import { describe, expect, expectTypeOf, it } from "vitest";
import type { components } from "@/lib/api/schema";
import type { StreamEvent } from "@/lib/api/types";
import {
  EVENT_REGISTRY,
  EVENT_TYPES,
  LATER_STAGE_EVENT_TYPES,
  PHASE_0_EVENT_TYPES,
  clientMessageSchema,
  parseStreamMessage,
  parseStreamText,
  streamEnvelopeSchema,
  tileAckMessage,
  tileSubscribeMessage,
  type KnownStreamEvent,
  type LaterStageStreamEvent,
  type Phase0StreamEvent,
} from "./events";
import { describeEvent } from "./describe-event";
import { createPublishedStreamEventCheck, publishedStreamEventTypes } from "@/tests/utils/contract";
import {
  FIXTURE_RUN_ID,
  FIXTURE_SESSION_ID,
  envelope,
  knownEnvelope,
  payloadFixtures,
} from "@/tests/utils/stream-fixtures";

type OpenApiStreamEvent = components["schemas"]["StreamEvent"];

const checkPublishedEnvelope = createPublishedStreamEventCheck();

describe("stream event types", () => {
  it("ties the zod types to the generated StreamEvent in both directions", () => {
    expectTypeOf<KnownStreamEvent>().toEqualTypeOf<OpenApiStreamEvent>();
    expectTypeOf<KnownStreamEvent>().toExtend<OpenApiStreamEvent>();
    expectTypeOf<OpenApiStreamEvent>().toExtend<KnownStreamEvent>();
    expectTypeOf<KnownStreamEvent["type"]>().toEqualTypeOf<OpenApiStreamEvent["type"]>();
    expectTypeOf<KnownStreamEvent>().toEqualTypeOf<StreamEvent>();
  });

  it("ties the Phase 0 and the later-stage zod events to their slice of the union", () => {
    type Phase0Type = Phase0StreamEvent["type"];
    expectTypeOf<Phase0StreamEvent>().toEqualTypeOf<
      Extract<OpenApiStreamEvent, { type: Phase0Type }>
    >();
    expectTypeOf<LaterStageStreamEvent>().toEqualTypeOf<
      Exclude<OpenApiStreamEvent, { type: Phase0Type }>
    >();
    expectTypeOf<Extract<KnownStreamEvent, { type: "tile.frame" }>>().toEqualTypeOf<
      Extract<OpenApiStreamEvent, { type: "tile.frame" }>
    >();
  });

  it("registers exactly the types of the published stream-event schema", () => {
    const published = publishedStreamEventTypes().toSorted();
    expect([...EVENT_TYPES].toSorted()).toEqual(published);
    expect(PHASE_0_EVENT_TYPES.length + LATER_STAGE_EVENT_TYPES.length).toBe(published.length);
  });

  it.each(EVENT_TYPES)("accepts the %s fixture envelope under the published schema", (type) => {
    const persisted = EVENT_REGISTRY[type].persistence === "persisted";
    expect(checkPublishedEnvelope(knownEnvelope(type, persisted ? 4 : null))).toEqual([]);
  });

  it("marks the stage and persistence of every registered type", () => {
    for (const type of EVENT_TYPES) {
      const definition = EVENT_REGISTRY[type];
      expect([0, 2, 3, 4]).toContain(definition.stage);
      expect(["persisted", "ephemeral"]).toContain(definition.persistence);
    }
    expect(EVENT_REGISTRY["stream.heartbeat"].persistence).toBe("ephemeral");
    expect(EVENT_REGISTRY["hello.tick"].persistence).toBe("persisted");
    expect(EVENT_REGISTRY["tile.frame"].stage).toBe(2);
  });
});

describe("parseStreamMessage", () => {
  it.each(EVENT_TYPES)("accepts a well formed %s event", (type) => {
    const persisted = EVENT_REGISTRY[type].persistence === "persisted";
    const parsed = parseStreamMessage(knownEnvelope(type, persisted ? 4 : null));
    expect(parsed.kind).toBe("known");
    if (parsed.kind === "known") {
      expect(parsed.event.type).toBe(type);
      expect(parsed.event.payload).toEqual(payloadFixtures[type]);
    }
  });

  it("returns unknown for an unregistered type and keeps its seq", () => {
    expect(parseStreamMessage(envelope("finding.created", 9, { anything: true }))).toEqual({
      kind: "unknown",
      type: "finding.created",
      seq: 9,
    });
  });

  it("does not treat inherited object keys as registered types", () => {
    expect(parseStreamMessage(envelope("constructor", null)).kind).toBe("unknown");
    expect(parseStreamMessage(envelope("__proto__", null)).kind).toBe("unknown");
    expect(parseStreamMessage(envelope("toString", null)).kind).toBe("unknown");
  });

  it("returns invalid when the envelope is malformed", () => {
    for (const bad of [
      null,
      "text",
      [],
      {},
      envelope("hello.tick", 0),
      envelope("hello.tick", 1.5),
      envelope("hello.tick", 1, {}, { ts: "yesterday" }),
      { ...envelope("hello.tick", 1), payload: "x" },
      { ...envelope("hello.tick", 1), run_id: 5 },
    ]) {
      expect(parseStreamMessage(bad).kind).toBe("invalid");
    }
  });

  it("returns invalid with the seq when a known payload is wrong", () => {
    const parsed = parseStreamMessage(envelope("hello.tick", 3, { n: "one" }));
    expect(parsed).toMatchObject({ kind: "invalid", type: "hello.tick", seq: 3 });
  });

  it("rejects a persisted event without a seq", () => {
    const parsed = parseStreamMessage(knownEnvelope("hello.tick", null));
    expect(parsed).toMatchObject({ kind: "invalid", type: "hello.tick" });
  });

  it("rejects a non empty heartbeat payload and an unknown stream.closing reason", () => {
    expect(parseStreamMessage(envelope("stream.heartbeat", null, { extra: 1 })).kind).toBe(
      "invalid",
    );
    expect(parseStreamMessage(envelope("stream.closing", null, { reason: "boredom" })).kind).toBe(
      "invalid",
    );
  });

  it("accepts offset timestamps", () => {
    const parsed = parseStreamMessage(
      knownEnvelope("hello.tick", 1, {}, { ts: "2026-09-30T14:03:22.123+00:00" }),
    );
    expect(parsed.kind).toBe("known");
  });

  it("parses text and survives invalid JSON", () => {
    expect(parseStreamText(JSON.stringify(knownEnvelope("hello.tick", 1))).kind).toBe("known");
    expect(parseStreamText("{not json")).toMatchObject({ kind: "invalid", type: null });
  });

  it("exports an envelope schema that requires every field", () => {
    for (const field of ["type", "run_id", "seq", "ts", "payload"] as const) {
      const { [field]: removed, ...rest } = envelope("hello.tick", 1);
      expect(removed).toBeDefined();
      expect(streamEnvelopeSchema.safeParse(rest).success).toBe(false);
    }
  });

  it("keeps the run id of the envelope", () => {
    const parsed = parseStreamMessage(knownEnvelope("hello.tick", 2));
    expect(parsed.kind === "known" && parsed.event.run_id).toBe(FIXTURE_RUN_ID);
  });
});

describe("client messages", () => {
  it("builds tile.subscribe and tile.ack messages that satisfy the schema", () => {
    const subscribe = tileSubscribeMessage([
      { browser_session_id: FIXTURE_SESSION_ID, mode: "grid" },
    ]);
    const ack = tileAckMessage(FIXTURE_SESSION_ID, 12);
    expect(clientMessageSchema.safeParse(subscribe).success).toBe(true);
    expect(clientMessageSchema.safeParse(ack).success).toBe(true);
    expect(ack).toEqual({
      type: "tile.ack",
      payload: { browser_session_id: FIXTURE_SESSION_ID, frame_seq: 12 },
    });
  });

  it("rejects an unknown mode and an unknown message type", () => {
    expect(
      clientMessageSchema.safeParse({
        type: "tile.subscribe",
        payload: { tiles: [{ browser_session_id: FIXTURE_SESSION_ID, mode: "huge" }] },
      }).success,
    ).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "tile.nope", payload: {} }).success).toBe(false);
  });
});

describe("describeEvent", () => {
  it.each(EVENT_TYPES)("describes %s with a title", (type) => {
    const persisted = EVENT_REGISTRY[type].persistence === "persisted";
    const parsed = parseStreamMessage(knownEnvelope(type, persisted ? 1 : null));
    expect(parsed.kind).toBe("known");
    if (parsed.kind === "known") {
      const description = describeEvent(parsed.event);
      expect(description.title.length).toBeGreaterThan(0);
      expect(["neutral", "info", "success", "warning", "danger"]).toContain(description.tone);
    }
  });

  it("marks a failed laya call and a failed run as danger", () => {
    const laya = parseStreamMessage(
      knownEnvelope("hello.laya", 5, { ok: false, error: "refused", status_code: null }),
    );
    const finished = parseStreamMessage(knownEnvelope("run.finished", 6, { status: "failed" }));
    expect(laya.kind === "known" && describeEvent(laya.event)).toMatchObject({
      tone: "danger",
      detail: "refused",
    });
    expect(finished.kind === "known" && describeEvent(finished.event).tone).toBe("danger");
  });
});
