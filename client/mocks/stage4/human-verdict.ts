import type { Step, Verdict } from "@/lib/api/types";
import type { LabelRecord } from "./label-seed";
import type { LabelsStore } from "./labels-store";

function latestFirst(left: LabelRecord, right: LabelRecord): number {
  return Date.parse(right.label.labeled_at) - Date.parse(left.label.labeled_at);
}

export function withHumanVerdict(step: Step, labels: LabelsStore): Step {
  const [latest] = labels
    .humanRecords()
    .filter(
      (record) => record.label.subject_type === "step" && record.label.subject_id === step.id,
    )
    .sort(latestFirst);
  if (latest === undefined) {
    return step;
  }
  const verdict: Verdict = {
    status: latest.label.value,
    tier: "human",
    confidence: null,
    reason_code: "human_label",
    reason: latest.label.note,
    skip_reason: null,
  };
  return { ...step, verdict };
}
