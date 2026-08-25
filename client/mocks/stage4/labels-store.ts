import type { Label, LabelStats, LabelSubjectType, LabelTask, LabelValue } from "@/lib/api/types";
import { newId } from "../factories/ids";
import {
  buildLabelSeed,
  STAGE_FOUR_SUBJECT_CYCLE,
  type LabelRecord,
  type LabelsSeed,
  type LabelTaskRecord,
} from "./label-seed";

const AGREEMENT_DECIMALS = 1000;

export interface HumanLabelInput {
  subject_type: LabelSubjectType;
  subject_id: string;
  value: LabelValue;
  note: string | null;
}

export interface SavedLabel {
  label: Label;
  replaced: boolean;
}

export interface LabelCounts {
  tasks: number;
  human: number;
  weak: number;
}

function isHumanBy(record: LabelRecord, userId: string): boolean {
  return record.label.source === "human" && record.label.labeled_by === userId;
}

function sameSubject(
  label: Pick<Label, "subject_type" | "subject_id">,
  task: Pick<LabelTask, "subject_type" | "subject_id">,
): boolean {
  return label.subject_type === task.subject_type && label.subject_id === task.subject_id;
}

export class LabelsStore {
  tasks: LabelTaskRecord[] = [];
  records: LabelRecord[] = [];

  constructor() {
    this.reset("default");
  }

  reset(seed: LabelsSeed = "default"): void {
    const data = buildLabelSeed(seed);
    this.tasks = data.tasks;
    this.records = data.records;
  }

  openTasksFor(userId: string): LabelTaskRecord[] {
    return this.tasks.filter(
      (entry) =>
        !this.records.some(
          (record) => isHumanBy(record, userId) && sameSubject(record.label, entry.task),
        ),
    );
  }

  findRecord(labelId: string): LabelRecord | undefined {
    return this.records.find((record) => record.label.id === labelId);
  }

  machineValueOf(subject: Pick<Label, "subject_type" | "subject_id">): LabelValue | null {
    return this.tasks.find((entry) => sameSubject(subject, entry.task))?.task.machine_value ?? null;
  }

  saveHuman(userId: string, input: HumanLabelInput, labeledAt: string): SavedLabel {
    const machineValue = this.machineValueOf(input);
    const existing = this.records.find(
      (record) =>
        isHumanBy(record, userId) &&
        record.label.subject_type === input.subject_type &&
        record.label.subject_id === input.subject_id,
    );
    if (existing !== undefined) {
      existing.label = {
        ...existing.label,
        value: input.value,
        note: input.note,
        labeled_at: labeledAt,
      };
      existing.machineValue = machineValue;
      return { label: existing.label, replaced: true };
    }
    const label: Label = {
      id: newId(),
      subject_type: input.subject_type,
      subject_id: input.subject_id,
      value: input.value,
      source: "human",
      note: input.note,
      labeled_by: userId,
      labeled_at: labeledAt,
    };
    this.records.push({ label, machineValue });
    return { label, replaced: false };
  }

  deleteRecord(labelId: string): void {
    this.records = this.records.filter((record) => record.label.id !== labelId);
  }

  humanRecords(): LabelRecord[] {
    return this.records.filter((record) => record.label.source === "human");
  }

  stats(): LabelStats {
    const human = this.humanRecords();
    const compared = human.filter((record) => record.machineValue !== null);
    const agreeing = compared.filter((record) => record.label.value === record.machineValue);
    const byType = Object.fromEntries(
      STAGE_FOUR_SUBJECT_CYCLE.map((type) => [
        type,
        human.filter((record) => record.label.subject_type === type).length,
      ]),
    );
    return {
      total_human: human.length,
      total_weak: this.records.length - human.length,
      by_subject_type: byType,
      agreement_with_machine:
        compared.length === 0
          ? null
          : Math.round((agreeing.length / compared.length) * AGREEMENT_DECIMALS) /
            AGREEMENT_DECIMALS,
    };
  }

  counts(): LabelCounts {
    const human = this.humanRecords().length;
    return { tasks: this.tasks.length, human, weak: this.records.length - human };
  }
}
