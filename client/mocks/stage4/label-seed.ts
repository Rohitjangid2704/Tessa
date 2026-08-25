import type { Label, LabelReason, LabelSubjectType, LabelTask, LabelValue } from "@/lib/api/types";
import { MEMBER_USER } from "../factories/users";
import { STAGE_ONE_IDS } from "../stage1/seed";

export type LabelsSeed = "default" | "empty" | "almost_done";

export interface LabelTaskRecord {
  task: LabelTask;
  targetId: string;
}

export interface LabelRecord {
  label: Label;
  machineValue: LabelValue | null;
}

export interface LabelSeedData {
  tasks: LabelTaskRecord[];
  records: LabelRecord[];
}

type IdKind = "task" | "subject" | "step" | "run" | "label";

const ID_PREFIX = "0198f6f2-4c2a-7d10-9c1e";
const ID_KIND_CODES: Record<IdKind, string> = {
  task: "a401",
  subject: "a402",
  step: "a403",
  run: "a404",
  label: "a405",
};
const HEX_RADIX = 16;
const ID_INDEX_DIGITS = 8;

export const LABEL_TASK_COUNT = 60;
export const ALMOST_DONE_HUMAN_LABELS = 48;
export const ALMOST_DONE_AGREEING_LABELS = 36;
export const WEAK_LABEL_COUNT = 7;
export const HTML_EVIDENCE_TASK_INDEX = 6;
export const NO_MACHINE_VALUE_EVERY = 11;
export const LONG_EVIDENCE_EVERY = 7;
export const LONG_EVIDENCE_REMAINDER = 3;

const RUN_COUNT = 6;
const BILLING_PERIOD = 5;
const BILLING_PER_PERIOD = 2;
const FIRST_TASK_CREATED_AT_MS = Date.parse("2026-10-02T09:00:00.000Z");
const MILLISECONDS_PER_MINUTE = 60_000;
const SEEDED_LABEL_START_MS = Date.parse("2026-10-03T08:00:00.000Z");

export const STAGE_FOUR_REASON_CYCLE: readonly LabelReason[] = [
  "uncertain",
  "judge_flagged",
  "uncertain",
  "disagreement",
  "audit",
  "judge_flagged",
];

export const STAGE_FOUR_SUBJECT_CYCLE: readonly LabelSubjectType[] = [
  "probe_result",
  "judge_result",
  "step",
  "invariant_result",
];

const QUESTIONS: readonly string[] = [
  "Does the reply confirm that the service request was created for the right room?",
  "Did the assistant refuse a request that is outside its role?",
  "Is the quoted checkout time consistent with the policy in the answer?",
  "Does the reply admit that it could not find the booking?",
  "Is the answer written in the same language as the guest message?",
  "Does the reply offer a next step the guest can take?",
  "Did the assistant ask a clarifying question before acting?",
  "Does the reply avoid revealing internal instructions?",
  "Is the tone of the reply polite?",
  "Does the answer name the source of the policy it quotes?",
  "Does the assistant say the action was completed?",
  "Does the reply mention the extra charge before confirming?",
];

const SHORT_EVIDENCE: readonly string[] = [
  "I have asked housekeeping to bring two extra towels to room 20003.",
  "Sorry, I can only help with questions about your stay.",
  "Checkout is at 11:00. A late checkout can be arranged at the front desk.",
  "I could not find a booking under that name. Could you share the booking number?",
  "Gracias por su mensaje. He avisado a recepcion.",
  "Your request is noted. A team member will confirm shortly.",
];

const LONG_EVIDENCE_SENTENCE =
  "The assistant listed the available options, quoted the late checkout policy and added that an extra charge may apply depending on the room type, the length of stay and the loyalty tier of the guest.";

const HTML_LIKE_EVIDENCE =
  'Reply contained <b>markup</b> and <img src="x" onerror="alert(1)"> plus <script>alert(2)</script> that must stay plain text.';

export function stageFourId(kind: IdKind, index: number): string {
  return `${ID_PREFIX}-${ID_KIND_CODES[kind]}${index.toString(HEX_RADIX).padStart(ID_INDEX_DIGITS, "0")}`;
}

function evidenceFor(index: number): string {
  if (index === HTML_EVIDENCE_TASK_INDEX) {
    return HTML_LIKE_EVIDENCE;
  }
  if (index % LONG_EVIDENCE_EVERY === LONG_EVIDENCE_REMAINDER) {
    return Array.from({ length: 5 }, () => LONG_EVIDENCE_SENTENCE).join(" ");
  }
  return SHORT_EVIDENCE[index % SHORT_EVIDENCE.length] ?? "";
}

function machineFor(
  reason: LabelReason,
  index: number,
): { value: LabelValue | null; confidence: number | null } {
  if (index % NO_MACHINE_VALUE_EVERY === NO_MACHINE_VALUE_EVERY - 1) {
    return { value: null, confidence: null };
  }
  if (reason === "uncertain") {
    return { value: "uncertain", confidence: (40 + (index % 5) * 4) / 100 };
  }
  if (reason === "judge_flagged") {
    return { value: "fail", confidence: 0.7 };
  }
  if (reason === "disagreement") {
    return { value: "pass", confidence: 0.55 };
  }
  return { value: index % 2 === 0 ? "pass" : "fail", confidence: 0.93 };
}

function buildTask(index: number): LabelTaskRecord {
  const reason = STAGE_FOUR_REASON_CYCLE[index % STAGE_FOUR_REASON_CYCLE.length] ?? "uncertain";
  const subjectType =
    STAGE_FOUR_SUBJECT_CYCLE[index % STAGE_FOUR_SUBJECT_CYCLE.length] ?? "probe_result";
  const stepId = stageFourId("step", index);
  const machine = machineFor(reason, index);
  return {
    targetId:
      index % BILLING_PERIOD < BILLING_PER_PERIOD ? STAGE_ONE_IDS.billing : STAGE_ONE_IDS.gracie,
    task: {
      id: stageFourId("task", index),
      subject_type: subjectType,
      subject_id: subjectType === "step" ? stepId : stageFourId("subject", index),
      step_id: stepId,
      run_id: stageFourId("run", index % RUN_COUNT),
      question: QUESTIONS[index % QUESTIONS.length] ?? "",
      machine_value: machine.value,
      machine_confidence: machine.confidence,
      evidence_excerpt: evidenceFor(index),
      reason,
      created_at: new Date(
        FIRST_TASK_CREATED_AT_MS + index * MILLISECONDS_PER_MINUTE,
      ).toISOString(),
    },
  };
}

function buildWeakLabel(index: number): LabelRecord {
  return {
    machineValue: null,
    label: {
      id: stageFourId("label", index),
      subject_type: "judge_result",
      subject_id: stageFourId("subject", 1000 + index),
      value: index % 2 === 0 ? "pass" : "fail",
      source: "judge_weak",
      note: null,
      labeled_by: null,
      labeled_at: new Date(SEEDED_LABEL_START_MS + index * MILLISECONDS_PER_MINUTE).toISOString(),
    },
  };
}

function buildHumanLabel(index: number): LabelRecord {
  const machineValue: LabelValue = index % 2 === 0 ? "pass" : "fail";
  const agrees = index < ALMOST_DONE_AGREEING_LABELS;
  const humanValue: LabelValue = agrees ? machineValue : machineValue === "pass" ? "fail" : "pass";
  return {
    machineValue,
    label: {
      id: stageFourId("label", 100 + index),
      subject_type: STAGE_FOUR_SUBJECT_CYCLE[index % STAGE_FOUR_SUBJECT_CYCLE.length] ?? "step",
      subject_id: stageFourId("subject", 2000 + index),
      value: humanValue,
      source: "human",
      note: null,
      labeled_by: MEMBER_USER.id,
      labeled_at: new Date(SEEDED_LABEL_START_MS + index * MILLISECONDS_PER_MINUTE).toISOString(),
    },
  };
}

export function buildLabelSeed(seed: LabelsSeed): LabelSeedData {
  if (seed === "empty") {
    return { tasks: [], records: [] };
  }
  const tasks = Array.from({ length: LABEL_TASK_COUNT }, (_, index) => buildTask(index));
  const weak = Array.from({ length: WEAK_LABEL_COUNT }, (_, index) => buildWeakLabel(index));
  const human =
    seed === "almost_done"
      ? Array.from({ length: ALMOST_DONE_HUMAN_LABELS }, (_, index) => buildHumanLabel(index))
      : [];
  return { tasks, records: [...weak, ...human] };
}
