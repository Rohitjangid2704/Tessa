import { Check, CircleDashed, X } from "lucide-react";
import { useId } from "react";
import { StatusBadge } from "@/components/status/status-badge";
import type { components } from "@/lib/api/schema";
import { cn } from "@/lib/utils";
import type { BundleValidationStatus } from "../format";
import { CompletenessBadge } from "./bundle-badges";
import { ScoreGauge } from "./score-gauge";

type BundleCompleteness = components["schemas"]["BundleCompleteness"];
type BundleCompletenessCheck = components["schemas"]["BundleCompletenessCheck"];

export type CheckCredit = "full" | "partial" | "none";

export function creditOf(check: BundleCompletenessCheck): CheckCredit {
  if (check.passed) {
    return "full";
  }
  return check.earned <= 0 ? "none" : "partial";
}

export function describeBarDistance(score: number, bar: number): string {
  if (score >= bar) {
    return score === bar
      ? `Exactly on the bar of ${bar}.`
      : `${score - bar} points above the bar of ${bar}.`;
  }
  return `${bar - score} ${bar - score === 1 ? "point" : "points"} short of the bar of ${bar}.`;
}

const CREDIT_LABELS: Record<CheckCredit, string> = {
  full: "Full credit",
  partial: "Partial credit",
  none: "No credit",
};

function CreditBadge({ credit }: { credit: CheckCredit }) {
  if (credit === "full") {
    return <StatusBadge tone="verdict-pass" label={CREDIT_LABELS.full} icon={Check} />;
  }
  if (credit === "partial") {
    return <StatusBadge tone="verdict-flaky" label={CREDIT_LABELS.partial} icon={CircleDashed} />;
  }
  return <StatusBadge tone="verdict-fail" label={CREDIT_LABELS.none} icon={X} />;
}

function CheckRow({ check }: { check: BundleCompletenessCheck }) {
  const credit = creditOf(check);
  const share =
    check.weight > 0 ? Math.min(100, Math.max(0, (check.earned / check.weight) * 100)) : 0;
  const showHint = credit !== "full" && check.fix_hint !== null && check.fix_hint !== undefined;

  return (
    <li
      data-check={check.id}
      data-credit={credit}
      className="flex flex-col gap-2 rounded-xl border p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{check.label}</h3>
        <span className="text-sm tabular-nums">
          <span className="font-semibold">{check.earned}</span> of {check.weight}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${check.label}, points earned`}
        aria-valuemin={0}
        aria-valuemax={check.weight}
        aria-valuenow={check.earned}
        aria-valuetext={`${check.earned} of ${check.weight} points`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full",
            credit === "full" && "bg-verdict-pass-fg",
            credit === "partial" && "bg-verdict-flaky-fg",
            credit === "none" && "bg-verdict-fail-fg",
          )}
          style={{ width: `${share}%` }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <CreditBadge credit={credit} />
        {check.detail ? (
          <span className="text-sm text-muted-foreground">{check.detail}</span>
        ) : null}
      </div>
      {showHint ? (
        <p className="text-sm">
          <span className="font-medium">How to fix: </span>
          {check.fix_hint}
        </p>
      ) : null}
    </li>
  );
}

export interface CompletenessPanelProps {
  completeness: BundleCompleteness;
  validationStatus: BundleValidationStatus;
}

export function CompletenessPanel({ completeness, validationStatus }: CompletenessPanelProps) {
  const headingId = useId();
  const open = completeness.checks.filter((check) => !check.passed).length;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={headingId} className="text-lg font-semibold">
          Completeness
        </h2>
        <CompletenessBadge status={completeness.status} />
      </div>
      <div className="grid gap-6 md:grid-cols-[minmax(0,18rem)_1fr] md:items-start">
        <div className="flex flex-col gap-2">
          <ScoreGauge
            score={completeness.score}
            bar={completeness.bar}
            label="Completeness score"
          />
          <p className="text-sm text-muted-foreground">
            {describeBarDistance(completeness.score, completeness.bar)}
          </p>
          <p className="text-sm text-muted-foreground">
            {open === 0
              ? "Every check earned full credit."
              : `${open} of ${completeness.checks.length} checks did not earn full credit.`}
          </p>
          {validationStatus === "invalid" ? (
            <p className="text-sm text-muted-foreground">
              The score is read from the raw manifest although the bundle did not validate, so no
              catalog was built from it.
            </p>
          ) : null}
        </div>
        <ol aria-label="Completeness checks" className="flex flex-col gap-3">
          {completeness.checks.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ol>
      </div>
    </section>
  );
}
