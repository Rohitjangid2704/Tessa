import { formatCount } from "@/features/runs/results-format";
import type { LabelSubjectType } from "@/lib/api/types";

export const LABEL_EXPORT_MIN_COUNT = 500;

export const LABEL_EXPORT_FULL_COUNT = 1000;

export type ExportMilestoneId = "export" | "full";

export interface ExportMilestone {
  id: ExportMilestoneId;
  count: number;
  title: string;
  meterLabel: string;
  reachedText: string;
}

export const EXPORT_MILESTONES: readonly ExportMilestone[] = [
  {
    id: "export",
    count: LABEL_EXPORT_MIN_COUNT,
    title: "Export unlocks",
    meterLabel: "Human labels toward the export threshold",
    reachedText: "Reached. The export is unlocked.",
  },
  {
    id: "full",
    count: LABEL_EXPORT_FULL_COUNT,
    title: "Full fine-tuning set",
    meterLabel: "Human labels toward the full fine-tuning set",
    reachedText: "Reached. This is the full set.",
  },
];

export const SUBJECT_TYPE_LABELS = {
  probe_result: "Probe results",
  judge_result: "Judge results",
  invariant_result: "Invariant results",
  step: "Steps",
} as const satisfies Record<LabelSubjectType, string>;

export function isExportReady(totalHuman: number): boolean {
  return totalHuman >= LABEL_EXPORT_MIN_COUNT;
}

export function milestoneRatio(totalHuman: number, count: number): number {
  return Math.min(1, Math.max(0, totalHuman) / count);
}

export function labelsMissing(totalHuman: number, count: number): number {
  return Math.max(0, count - totalHuman);
}

export function describeMilestone(totalHuman: number, milestone: ExportMilestone): string {
  const shown = Math.min(totalHuman, milestone.count);
  const progress = `${formatCount(shown)} of ${formatCount(milestone.count)} human labels`;
  const missing = labelsMissing(totalHuman, milestone.count);
  return missing === 0 ? progress : `${progress}, ${formatCount(missing)} more needed`;
}

export function describeExportBlocked(totalHuman: number): string {
  const missing = labelsMissing(totalHuman, LABEL_EXPORT_MIN_COUNT);
  return `The export unlocks at ${formatCount(LABEL_EXPORT_MIN_COUNT)} human labels. ${formatCount(totalHuman)} exist, ${formatCount(missing)} more are needed.`;
}

export function countJsonlLines(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}
