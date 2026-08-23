"use client";

import { useId } from "react";
import { BudgetMeter } from "@/components/status/budget-meter";
import type { BudgetState } from "@/lib/api/types";
import { useThrottledValue } from "@/lib/use-throttled-value";

export const STEP_ANNOUNCE_INTERVAL_MS = 2000;

export type StepCounterProps = {
  actionCount: number;
  budget: BudgetState;
  phase: "exploring" | "verifying" | "ended";
};

const PHASE_TEXT = {
  exploring: "Exploring",
  verifying: "Verifying what was found",
  ended: "Finished",
} as const satisfies Record<StepCounterProps["phase"], string>;

export function describeStepCount(actionCount: number): string {
  return actionCount === 1 ? "1 action so far" : `${actionCount} actions so far`;
}

export function StepCounter({ actionCount, budget, phase }: StepCounterProps) {
  const headingId = useId();
  const announced = useThrottledValue(
    `${PHASE_TEXT[phase]}: ${describeStepCount(actionCount)}`,
    STEP_ANNOUNCE_INTERVAL_MS,
  );

  return (
    <section
      aria-labelledby={headingId}
      data-slot="step-counter"
      data-phase={phase}
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl border px-4 py-3"
    >
      <div className="flex items-baseline gap-3">
        <h2 id={headingId} className="sr-only">
          Progress
        </h2>
        <span className="text-3xl font-semibold tabular-nums" data-slot="step-count">
          {actionCount}
        </span>
        <span className="text-sm text-muted-foreground">
          {actionCount === 1 ? "action" : "actions"} · {PHASE_TEXT[phase]}
        </span>
      </div>
      <BudgetMeter budget={budget} />
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announced}
      </div>
    </section>
  );
}
