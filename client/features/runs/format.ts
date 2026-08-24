import type { Verdict } from "@/lib/api/types";

const MS_PER_SECOND = 1000;
const PERCENT = 100;

export function formatConfidence(confidence: number | null | undefined): string | null {
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) {
    return null;
  }
  return `${Math.round(Math.min(1, Math.max(0, confidence)) * PERCENT)}%`;
}

export function formatMilliseconds(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return "n/a";
  }
  if (milliseconds < MS_PER_SECOND) {
    return `${Math.round(milliseconds)} ms`;
  }
  return `${(milliseconds / MS_PER_SECOND).toFixed(1)} s`;
}

export function isEscalated(verdict: Pick<Verdict, "tier"> | null | undefined): boolean {
  return verdict?.tier === "judge" || verdict?.tier === "human";
}
