import type { RetentionPolicy } from "@/lib/api/types";
import { RETENTION_FIELDS, type RetentionField } from "./schemas";

const MILLISECONDS_PER_DAY = 86_400_000;

export interface RetentionReduction {
  field: RetentionField;
  fromDays: number;
  toDays: number;
  cutoffIso: string;
}

export function cutoffIso(nowMs: number, days: number): string {
  return new Date(nowMs - days * MILLISECONDS_PER_DAY).toISOString();
}

export function findReductions(
  current: RetentionPolicy,
  next: RetentionPolicy,
  nowMs: number,
): RetentionReduction[] {
  return RETENTION_FIELDS.filter((field) => next[field] < current[field]).map((field) => ({
    field,
    fromDays: current[field],
    toDays: next[field],
    cutoffIso: cutoffIso(nowMs, next[field]),
  }));
}
