"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleCheck } from "lucide-react";
import { useId } from "react";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import type { LabelStats } from "@/lib/api/types";
import { labelStatsQuery } from "../queries";
import { LABEL_GOAL } from "../schemas";

const PERCENT = 100;

export function progressPercent(total: number, goal: number = LABEL_GOAL): number {
  return Math.min(PERCENT, Math.round((Math.max(0, total) / goal) * PERCENT));
}

export function describeAgreement(agreement: number | null): string {
  if (agreement === null) {
    return "No agreement figure yet. It appears after the first human label.";
  }
  const clamped = Math.min(1, Math.max(0, agreement));
  return `${Math.round(clamped * PERCENT)}% agreement with the machine, across every human label`;
}

export interface ProgressSummaryProps {
  stats: LabelStats;
  goal?: number;
}

export function ProgressSummary({ stats, goal = LABEL_GOAL }: ProgressSummaryProps) {
  const headingId = useId();
  const shown = Math.min(stats.total_human, goal);
  const reached = stats.total_human >= goal;
  const valueText = `${shown} of ${goal} labels`;
  const percent = progressPercent(stats.total_human, goal);
  return (
    <section
      aria-labelledby={headingId}
      data-slot="label-progress"
      data-reached={reached ? "true" : undefined}
      className="flex max-w-3xl flex-col gap-2"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-sm font-medium">
          Labels toward the first {goal}
        </h2>
        <p className="tabular-nums" data-slot="label-progress-count">
          <span className="text-2xl font-semibold">{shown}</span>
          <span className="text-sm text-muted-foreground"> of {goal}</span>
        </p>
      </div>
      <Progress
        value={percent}
        aria-label="Labels toward the goal"
        aria-valuenow={percent}
        aria-valuetext={valueText}
        className="h-2"
      />
      <p className="text-sm text-muted-foreground" data-slot="label-agreement">
        {describeAgreement(stats.agreement_with_machine)}
      </p>
      {reached ? (
        <p className="flex items-center gap-1.5 text-sm font-medium" data-slot="label-goal-reached">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
          {`${goal} of ${goal} reached.`}
          {stats.total_human > goal
            ? ` ${stats.total_human} labels in all, more still help.`
            : " More labels still help."}
        </p>
      ) : null}
    </section>
  );
}

export function LabelProgress() {
  const stats = useQuery(labelStatsQuery());

  if (stats.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex max-w-3xl flex-col gap-2">
        <span className="sr-only">Loading label progress</span>
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-4 w-72" />
      </div>
    );
  }

  if (stats.isError) {
    const requestId = readRequestId(stats.error);
    return (
      <div role="alert" className="flex max-w-3xl flex-wrap items-center gap-3 text-sm">
        <span>
          Could not load label progress. {describeApiError(stats.error)}
          {requestId === null ? "" : ` (request ${requestId})`}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => void stats.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return <ProgressSummary stats={stats.data} />;
}
