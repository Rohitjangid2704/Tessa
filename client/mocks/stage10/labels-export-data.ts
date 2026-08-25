import { stableId, stableInt } from "../stage2/ids";

export const LABEL_EXPORT_FILENAME = "tessa-labels-export.jsonl";

export const LABEL_EXPORT_CONTENT_TYPE = "application/x-ndjson";

export const LABEL_EXPORT_MAX_LINES = 5000;

const HELD_OUT_EVERY = 5;
const RUN_GROUPS = 24;
const FIRST_LABEL_MS = Date.parse("2026-09-01T08:00:00.000Z");
const MILLISECONDS_PER_MINUTE = 60_000;

const QUESTIONS = [
  { id: "generic.answers_the_question", subject_type: "probe_result" },
  { id: "generic.admits_uncertainty", subject_type: "probe_result" },
  { id: "llm_app.refuses_out_of_scope", subject_type: "probe_result" },
  { id: "llm_app.leaks_system_prompt", subject_type: "probe_result" },
  { id: "target.gracie.names_room", subject_type: "judge_result" },
  { id: "target.gracie.offers_escalation", subject_type: "judge_result" },
] as const;

function decisionAt(index: number): "pass" | "fail" | "uncertain" {
  const roll = stableInt(0, 99, "label-export-decision", index);
  if (roll < 74) {
    return "pass";
  }
  return roll < 94 ? "fail" : "uncertain";
}

export function buildLabelExportLine(index: number): string {
  const question = QUESTIONS[index % QUESTIONS.length] ?? QUESTIONS[0];
  const runOrdinal = stableInt(0, RUN_GROUPS - 1, "label-export-run", index);
  return JSON.stringify({
    id: stableId("label-export", index),
    run_id: stableId("label-export-run", runOrdinal),
    split: runOrdinal % HELD_OUT_EVERY === 0 ? "held_out" : "train",
    subject_type: question.subject_type,
    question_id: question.id,
    text: `Synthetic export answer ${index + 1}`,
    decision: decisionAt(index),
    labeled_at: new Date(FIRST_LABEL_MS + index * MILLISECONDS_PER_MINUTE).toISOString(),
  });
}

export function buildLabelExport(count: number): string {
  const lines = Math.min(Math.max(0, count), LABEL_EXPORT_MAX_LINES);
  return Array.from({ length: lines }, (_, index) => `${buildLabelExportLine(index)}\n`).join("");
}
