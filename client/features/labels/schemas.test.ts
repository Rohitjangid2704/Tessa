import { describe, expect, it } from "vitest";
import { AttemptKeyRing, labelFingerprint } from "./attempt-keys";
import {
  BLIND_REASONS,
  describeLabeled,
  describeProgress,
  isAlwaysBlind,
  isCorrectionSubject,
  LABEL_NOTE_MAX_LENGTH,
  LABEL_REASON_HINTS,
  LABEL_REASON_LABELS,
  LABEL_REASONS,
  LABEL_SUBJECT_LABELS,
  LABEL_SUBJECT_NOUNS,
  LABEL_SUBJECT_TYPES,
  LABEL_VALUE_HINTS,
  LABEL_VALUE_LABELS,
  LABEL_VALUES,
  labelCreateSchema,
  queueFiltersCodec,
} from "./schemas";

const SUBJECT_ID = "0198f6f2-4c2a-7d10-9c1e-a40200000001";

describe("wire enums", () => {
  it("lists the contract values and labels every one", () => {
    expect(LABEL_VALUES).toEqual(["pass", "fail", "uncertain"]);
    expect(LABEL_SUBJECT_TYPES).toEqual([
      "probe_result",
      "judge_result",
      "invariant_result",
      "step",
    ]);
    expect(LABEL_REASONS).toEqual(["uncertain", "judge_flagged", "disagreement", "audit"]);
    for (const value of LABEL_VALUES) {
      expect(LABEL_VALUE_LABELS[value]).not.toBe("");
      expect(LABEL_VALUE_HINTS[value]).not.toBe("");
    }
    for (const type of LABEL_SUBJECT_TYPES) {
      expect(LABEL_SUBJECT_LABELS[type]).not.toBe("");
      expect(LABEL_SUBJECT_NOUNS[type]).not.toBe("");
    }
    for (const reason of LABEL_REASONS) {
      expect(LABEL_REASON_LABELS[reason]).not.toBe("");
      expect(LABEL_REASON_HINTS[reason]).not.toBe("");
    }
  });

  it("marks only audit and disagreement as always blind", () => {
    expect(BLIND_REASONS).toEqual(["audit", "disagreement"]);
    expect(LABEL_REASONS.filter(isAlwaysBlind)).toEqual(["disagreement", "audit"]);
  });

  it("treats judge and probe results as the subjects that correct a step", () => {
    expect(LABEL_SUBJECT_TYPES.filter(isCorrectionSubject)).toEqual([
      "probe_result",
      "judge_result",
    ]);
  });
});

describe("labelCreateSchema", () => {
  const valid = { subject_type: "step", subject_id: SUBJECT_ID, value: "fail" };

  it("accepts a label with and without a note", () => {
    expect(labelCreateSchema.safeParse(valid).success).toBe(true);
    expect(labelCreateSchema.safeParse({ ...valid, note: "wrong room" }).success).toBe(true);
  });

  it("rejects an unknown subject type, value or id and a note over the limit", () => {
    expect(labelCreateSchema.safeParse({ ...valid, subject_type: "run" }).success).toBe(false);
    expect(labelCreateSchema.safeParse({ ...valid, value: "maybe" }).success).toBe(false);
    expect(labelCreateSchema.safeParse({ ...valid, subject_id: "nope" }).success).toBe(false);
    expect(
      labelCreateSchema.safeParse({ ...valid, note: "x".repeat(LABEL_NOTE_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });
});

describe("progress wording", () => {
  it("shows the count of the goal, capped at the goal", () => {
    expect(describeProgress(12)).toBe("12 of 50");
    expect(describeProgress(50)).toBe("50 of 50");
    expect(describeProgress(62)).toBe("50 of 50, 62 labels in all");
  });

  it("announces a label with the progress, or alone while the count is unknown", () => {
    expect(describeLabeled("pass", 12)).toBe("labeled pass, 12 of 50");
    expect(describeLabeled("uncertain", null)).toBe("labeled uncertain");
  });
});

describe("queueFiltersCodec", () => {
  it("reads the three filters from the URL and drops invalid values", () => {
    const values = queueFiltersCodec.parse(
      new URLSearchParams(
        `subject_type=step&subject_type=nope&subject_type=probe_result&reason=audit&target_id=${SUBJECT_ID}`,
      ),
    );

    expect(values).toEqual({
      subject_type: ["probe_result", "step"],
      reason: ["audit"],
      target_id: SUBJECT_ID,
    });
    expect(
      queueFiltersCodec.parse(new URLSearchParams("target_id=not-a-guid")).target_id,
    ).toBeUndefined();
  });

  it("writes the filters back and counts the active ones", () => {
    const values = { subject_type: ["step" as const], target_id: SUBJECT_ID };

    expect(queueFiltersCodec.serialize(values).toString()).toBe(
      `subject_type=step&target_id=${SUBJECT_ID}`,
    );
    expect(queueFiltersCodec.activeKeys(values)).toEqual(["subject_type", "target_id"]);
    expect(queueFiltersCodec.activeKeys({})).toEqual([]);
  });
});

describe("AttemptKeyRing", () => {
  const label = { subject_type: "step" as const, subject_id: SUBJECT_ID, value: "pass" as const };

  it("hands out the same key for the same label until it settles", () => {
    const ring = new AttemptKeyRing();
    const fingerprint = labelFingerprint(label);

    const first = ring.keyFor(fingerprint);
    expect(ring.keyFor(fingerprint)).toBe(first);

    ring.settle(fingerprint);
    expect(ring.keyFor(fingerprint)).not.toBe(first);
  });

  it("gives a different key for a different value or note", () => {
    const ring = new AttemptKeyRing();

    const pass = ring.keyFor(labelFingerprint(label));
    expect(ring.keyFor(labelFingerprint({ ...label, value: "fail" }))).not.toBe(pass);
    expect(ring.keyFor(labelFingerprint({ ...label, note: "why" }))).not.toBe(pass);
  });
});
