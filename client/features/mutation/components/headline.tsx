import { KpiStatus } from "@/features/home/components/kpi-tile";
import { describeMutationHeadline, describeSurvivors } from "@/features/home/mutation-headline";
import { cn } from "@/lib/utils";
import type { MutationSummary } from "../types";

const PERCENT = 100;

export type HeadlineProps = {
  summary: MutationSummary;
  className?: string;
};

function powerPercent(power: number): string {
  return `${Math.round(Math.min(1, Math.max(0, power)) * PERCENT)}%`;
}

export function Headline({ summary, className }: HeadlineProps) {
  const headline = describeMutationHeadline(summary);
  return (
    <div
      data-slot="mutation-headline"
      data-tone={headline.tone}
      className={cn("flex flex-col gap-2 rounded-xl border bg-card p-4", className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <KpiStatus tone={headline.tone} label={headline.statusLabel} />
        {summary.total === 0 ? null : (
          <span className="text-sm text-muted-foreground">
            Suite power {powerPercent(summary.suite_power)}
          </span>
        )}
      </div>
      <p className="text-lg font-semibold">{headline.text}</p>
      {headline.survivorNames.length === 0 ? null : (
        <p className="text-sm text-muted-foreground">
          {describeSurvivors(headline.survivorNames)}
        </p>
      )}
    </div>
  );
}
