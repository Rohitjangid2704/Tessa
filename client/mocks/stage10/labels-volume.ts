import type { LabelStats } from "@/lib/api/types";
import { STAGE_FOUR_SUBJECT_CYCLE } from "../stage4/label-seed";
import type { LabelsStore } from "../stage4/labels-store";
import { mockState } from "../state";

export const LABEL_VOLUME_SEEDS = [
  "default",
  "below_min",
  "at_min",
  "fixture",
  "at_goal",
  "beyond_goal",
] as const;

export type LabelVolumeSeed = (typeof LABEL_VOLUME_SEEDS)[number];

export const LABEL_EXPORT_DEFAULT_MIN_COUNT = 500;

const TARGET_TOTAL_HUMAN: Readonly<Record<LabelVolumeSeed, number | null>> = {
  default: null,
  below_min: 312,
  at_min: 500,
  fixture: 600,
  at_goal: 1000,
  beyond_goal: 1260,
};

const EXTRA_AGREEMENT_RATE = 0.84;
const AGREEMENT_DECIMALS = 1000;

export class LabelVolume {
  private seedName: LabelVolumeSeed = "default";
  private extra = 0;

  get seed(): LabelVolumeSeed {
    return this.seedName;
  }

  get extraHuman(): number {
    return this.extra;
  }

  apply(seed: LabelVolumeSeed, baseHuman: number): void {
    const target = TARGET_TOTAL_HUMAN[seed];
    this.seedName = seed;
    this.extra = target === null ? 0 : Math.max(0, target - baseHuman);
  }

  reset(): void {
    this.seedName = "default";
    this.extra = 0;
  }
}

export const labelVolume = new LabelVolume();

mockState.stageTwo.onReset(() => labelVolume.reset());

function spreadAcrossSubjectTypes(
  base: LabelStats["by_subject_type"],
  extra: number,
): LabelStats["by_subject_type"] {
  const types = STAGE_FOUR_SUBJECT_CYCLE.length;
  const share = Math.floor(extra / types);
  const remainder = extra % types;
  return Object.fromEntries(
    STAGE_FOUR_SUBJECT_CYCLE.map((type, index) => [
      type,
      (base[type] ?? 0) + share + (index < remainder ? 1 : 0),
    ]),
  );
}

export function buildLabelStats(labels: LabelsStore): LabelStats {
  const base = labels.stats();
  const extra = labelVolume.extraHuman;
  if (extra === 0) {
    return base;
  }
  const compared = labels.humanRecords().filter((record) => record.machineValue !== null);
  const agreeing = compared.filter((record) => record.label.value === record.machineValue).length;
  const comparedTotal = compared.length + extra;
  const agreeingTotal = agreeing + Math.round(extra * EXTRA_AGREEMENT_RATE);
  return {
    ...base,
    total_human: base.total_human + extra,
    by_subject_type: spreadAcrossSubjectTypes(base.by_subject_type, extra),
    agreement_with_machine:
      Math.round((agreeingTotal / comparedTotal) * AGREEMENT_DECIMALS) / AGREEMENT_DECIMALS,
  };
}

export function applyLabelVolumeSeed(seed: LabelVolumeSeed): LabelStats {
  const labels = mockState.stageFour.labels;
  labelVolume.apply(seed, labels.stats().total_human);
  return buildLabelStats(labels);
}
