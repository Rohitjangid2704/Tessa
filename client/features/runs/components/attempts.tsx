import { pluralize } from "@/features/bundles/format";
import type { RunScenarioAttempt, StepSummary } from "@/lib/api/types";
import { RunScenarioStatusBadge } from "./run-scenario-status-badge";
import { SkipReasonBadge } from "./skip-reason-badge";
import { ScenarioStepRow } from "./step-row";
import { VerdictChips } from "./verdict-chips";

export type AttemptsProps = {
  runId: string;
  attempts: readonly RunScenarioAttempt[];
  steps: readonly StepSummary[];
  attemptsTotal: number;
};

function attemptNumbers(
  attempts: readonly RunScenarioAttempt[],
  steps: readonly StepSummary[],
): number[] {
  const numbers = new Set([
    ...attempts.map((attempt) => attempt.attempt),
    ...steps.map((step) => step.attempt),
  ]);
  return [...numbers].sort((left, right) => left - right);
}

function summarizeSteps(steps: readonly StepSummary[]): string {
  const uncertain = steps.filter((step) => step.verdict?.status === "uncertain").length;
  const total = pluralize(steps.length, "step");
  return uncertain === 0 ? total : `${total}, ${uncertain} uncertain`;
}

export function Attempts({ runId, attempts, steps, attemptsTotal }: AttemptsProps) {
  const numbers = attemptNumbers(attempts, steps);
  if (numbers.length === 0) {
    return <p className="text-sm text-muted-foreground">No attempts have started yet.</p>;
  }
  return (
    <ol aria-label="Attempts" data-slot="attempts" className="flex flex-col gap-4">
      {numbers.map((number) => {
        const attempt = attempts.find((candidate) => candidate.attempt === number);
        const attemptSteps = steps
          .filter((step) => step.attempt === number)
          .sort((left, right) => left.index - right.index);
        const skipReason = attempt?.verdict?.skip_reason ?? null;
        return (
          <li
            key={number}
            data-slot="attempt"
            data-attempt={number}
            className="flex flex-col gap-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">
                Attempt {number + 1} of {Math.max(attemptsTotal, number + 1)}
              </h3>
              {attempt === undefined ? null : <RunScenarioStatusBadge status={attempt.status} />}
              {attempt?.verdict ? <VerdictChips verdict={attempt.verdict} /> : null}
              {skipReason === null ? null : <SkipReasonBadge reason={skipReason} />}
              <span className="text-xs text-muted-foreground">{summarizeSteps(attemptSteps)}</span>
            </div>
            {attemptSteps.length === 0 ? (
              <p className="text-sm text-muted-foreground">No steps recorded yet.</p>
            ) : (
              <ul aria-label={`Steps of attempt ${number + 1}`} className="flex flex-col gap-0.5">
                {attemptSteps.map((step) => (
                  <ScenarioStepRow key={step.id} runId={runId} step={step} />
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
