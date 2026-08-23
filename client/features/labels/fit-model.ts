import { isRunTerminal } from "@/lib/api/polling";
import type {
  CalibrationFit,
  CalibrationHeldOut,
  CalibrationThresholds,
  RunStatus,
  SettingsRead,
} from "@/lib/api/types";

export const THRESHOLD_ROWS = [
  { key: "probe_confidence", label: "Probe confidence" },
  { key: "judge_escalate_below", label: "Escalate to the judge below" },
] as const satisfies ReadonlyArray<{ key: keyof CalibrationThresholds; label: string }>;

export type FitPhase = "running" | "failed" | "no_proposal" | "adopted" | "applied" | "proposal";

const THRESHOLD_DECIMALS = 2;
const KAPPA_DECIMALS = 2;

export type ThresholdsInForce = Pick<
  SettingsRead["thresholds"],
  "probe_confidence" | "judge_escalate_below"
>;

export function formatThreshold(value: number): string {
  return value.toFixed(THRESHOLD_DECIMALS);
}

export function thresholdsMatch(
  current: ThresholdsInForce | undefined,
  proposed: CalibrationThresholds,
): boolean {
  return (
    current !== undefined && THRESHOLD_ROWS.every((row) => current[row.key] === proposed[row.key])
  );
}

export function fitPhase(fit: CalibrationFit, inForce: boolean): FitPhase {
  if (!isRunTerminal(fit)) {
    return "running";
  }
  if (fit.status !== "completed") {
    return "failed";
  }
  if (fit.thresholds === null) {
    return "no_proposal";
  }
  if (fit.adopted) {
    return "adopted";
  }
  return inForce ? "applied" : "proposal";
}

export function describeKappaChange(heldOut: CalibrationHeldOut): string {
  const { kappa_before: before, kappa_after: after } = heldOut;
  if (before === null || after === null) {
    return "Kappa could not be measured because too few held-out labels had a decided grade.";
  }
  const from = before.toFixed(KAPPA_DECIMALS);
  const to = after.toFixed(KAPPA_DECIMALS);
  if (after > before) {
    return `Kappa rose from ${from} to ${to} on the held-out labels.`;
  }
  if (after < before) {
    return `Kappa fell from ${from} to ${to} on the held-out labels.`;
  }
  return `Kappa stayed at ${to} on the held-out labels.`;
}

export interface FailedFitCopy {
  title: string;
  description: string;
}

export function describeFailedFit(status: RunStatus): FailedFitCopy {
  if (status === "canceled") {
    return {
      title: "The fit was canceled",
      description: "Nothing changed. Start a new fit when you are ready.",
    };
  }
  if (status === "budget_exceeded") {
    return {
      title: "The fit ran out of budget",
      description: "Nothing changed. The run stopped at its spending limit before it finished.",
    };
  }
  return {
    title: "The fit failed",
    description:
      "Nothing changed. Open the run to read its events for the reason, then start a new fit.",
  };
}

export function sortedTemperatures(
  temperatures: CalibrationFit["temperatures"],
): ReadonlyArray<readonly [string, number]> {
  return Object.entries(temperatures).sort(([left], [right]) => left.localeCompare(right));
}
