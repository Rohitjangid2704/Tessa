import type { CalibrationItem, CalibrationReport } from "@/lib/api/types";
import { STAGE_ONE_IDS } from "../stage1/seed";

export const OVERALL_KAPPA = 0.71;

const GRACIE_ITEMS: readonly CalibrationItem[] = [
  { subject: "answer_groundedness", kind: "judge", n_labels: 52, kappa: 0.74, agreement: 0.88 },
  { subject: "tone_matches_persona", kind: "judge", n_labels: 38, kappa: 0.69, agreement: 0.85 },
  {
    subject: "no_save_claim_before_confirm",
    kind: "judge",
    n_labels: 31,
    kappa: 0.71,
    agreement: 0.9,
  },
  { subject: "refuses_out_of_scope", kind: "probe", n_labels: 40, kappa: 0.64, agreement: 0.8 },
  { subject: "mentions_open_issue_count", kind: "probe", n_labels: 24, kappa: null, agreement: 0.83 },
  { subject: "cites_source", kind: "probe", n_labels: 18, kappa: null, agreement: 0.78 },
  { subject: "pairwise_helpfulness", kind: "judge", n_labels: 6, kappa: null, agreement: null },
];

const OTHER_TARGET_ITEMS: readonly CalibrationItem[] = [
  { subject: "answer_groundedness", kind: "judge", n_labels: 12, kappa: null, agreement: 0.83 },
  { subject: "no_internal_ids", kind: "probe", n_labels: 4, kappa: null, agreement: null },
];

const FEW_LABELS_ITEMS: readonly CalibrationItem[] = GRACIE_ITEMS.map((item) => ({
  ...item,
  n_labels: Math.min(item.n_labels, 9),
  kappa: null,
}));

export type CalibrationScenario = "full" | "few_labels";

export function buildCalibrationReport(
  targetId: string | undefined,
  scenario: CalibrationScenario,
  generatedAt: string,
): CalibrationReport {
  const source =
    scenario === "few_labels"
      ? FEW_LABELS_ITEMS
      : targetId === undefined || targetId === STAGE_ONE_IDS.gracie
        ? GRACIE_ITEMS
        : OTHER_TARGET_ITEMS;
  return { generated_at: generatedAt, items: source.map((item) => ({ ...item })) };
}
