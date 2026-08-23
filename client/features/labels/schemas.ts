import { z } from "zod";
import type { LabelCreate, LabelReason, LabelSubjectType, LabelValue } from "@/lib/api/types";
import { createSearchParamsCodec, enumListParam } from "@/lib/search-params";

export const LABEL_VALUES = ["pass", "fail", "uncertain"] as const satisfies readonly LabelValue[];

export const LABEL_SUBJECT_TYPES = [
  "probe_result",
  "judge_result",
  "invariant_result",
  "step",
] as const satisfies readonly LabelSubjectType[];

export const LABEL_REASONS = [
  "uncertain",
  "judge_flagged",
  "disagreement",
  "audit",
] as const satisfies readonly LabelReason[];

export const LABEL_VALUE_LABELS: Record<LabelValue, string> = {
  pass: "Pass",
  fail: "Fail",
  uncertain: "Uncertain",
};

export const LABEL_VALUE_HINTS: Record<LabelValue, string> = {
  pass: "The answer was acceptable",
  fail: "The answer was wrong or harmful",
  uncertain: "A person cannot tell either",
};

export const LABEL_SUBJECT_LABELS: Record<LabelSubjectType, string> = {
  probe_result: "Probe result",
  judge_result: "Judge result",
  invariant_result: "Invariant result",
  step: "Step verdict",
};

export const LABEL_SUBJECT_NOUNS: Record<LabelSubjectType, string> = {
  probe_result: "probe result",
  judge_result: "judge result",
  invariant_result: "invariant result",
  step: "step",
};

export const LABEL_REASON_LABELS: Record<LabelReason, string> = {
  uncertain: "Uncertain",
  judge_flagged: "Judge flagged",
  disagreement: "Disagreement",
  audit: "Audit",
};

export const LABEL_REASON_HINTS: Record<LabelReason, string> = {
  uncertain: "The graders could not decide",
  judge_flagged: "The judge asked for a person to look",
  disagreement: "The graders disagreed with each other",
  audit: "A random check of a confident grade",
};

export const BLIND_REASONS: readonly LabelReason[] = ["audit", "disagreement"];

export const LABEL_GOAL = 50;
export const LABEL_NOTE_MAX_LENGTH = 1000;

export const labelCreateSchema = z.object({
  subject_type: z.enum(LABEL_SUBJECT_TYPES),
  subject_id: z.guid(),
  value: z.enum(LABEL_VALUES),
  note: z.string().max(LABEL_NOTE_MAX_LENGTH).optional(),
}) satisfies z.ZodType<LabelCreate>;

const targetIdParam = z.preprocess((raw) => {
  const value: unknown = Array.isArray(raw) ? raw[0] : undefined;
  return z.guid().safeParse(value).success ? value : undefined;
}, z.string().optional());

export const queueFiltersCodec = createSearchParamsCodec({
  subject_type: enumListParam(LABEL_SUBJECT_TYPES),
  reason: enumListParam(LABEL_REASONS),
  target_id: targetIdParam,
});

export type QueueFilters = ReturnType<typeof queueFiltersCodec.parse>;

export function isCorrectionSubject(subjectType: LabelSubjectType): boolean {
  return subjectType === "judge_result" || subjectType === "probe_result";
}

export function isAlwaysBlind(reason: LabelReason): boolean {
  return BLIND_REASONS.includes(reason);
}

export function describeProgress(total: number, goal: number = LABEL_GOAL): string {
  const shown = Math.min(total, goal);
  return total > goal ? `${shown} of ${goal}, ${total} labels in all` : `${shown} of ${goal}`;
}

export function describeLabeled(value: LabelValue, total: number | null): string {
  return total === null ? `labeled ${value}` : `labeled ${value}, ${describeProgress(total)}`;
}
