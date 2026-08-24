"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import type { RunScenarioSummary } from "@/lib/api/types";
import { formatDuration } from "@/lib/format-duration";
import { scenarioRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { runScenarioQuery } from "../queries";
import { Attempts } from "./attempts";
import { RunScenarioStatusBadge } from "./run-scenario-status-badge";
import { SkipReasonBadge, SkipReasonNotice } from "./skip-reason-badge";
import { VerdictChips } from "./verdict-chips";

export type ScenarioRowProps = {
  runId: string;
  scenario: RunScenarioSummary;
};

function ScenarioOutcome({ scenario }: { scenario: RunScenarioSummary }) {
  const skipReason = scenario.verdict?.skip_reason ?? null;
  if (skipReason !== null) {
    return <SkipReasonBadge reason={skipReason} />;
  }
  return scenario.verdict === null ? null : <VerdictChips verdict={scenario.verdict} />;
}

function ScenarioRowDetailsSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-2">
      <span className="sr-only">Loading the scenario</span>
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

function ScenarioRowDetails({ runId, scenario }: ScenarioRowProps) {
  const detail = useQuery(runScenarioQuery(scenario.id));

  if (detail.isPending) {
    return <ScenarioRowDetailsSkeleton />;
  }
  if (detail.isError) {
    return (
      <ErrorState
        title="Could not load this scenario"
        description={describeApiError(detail.error)}
        requestId={readRequestId(detail.error)}
        onRetry={() => void detail.refetch()}
        className="py-6"
      />
    );
  }

  const { data } = detail;
  return (
    <div className="flex flex-col gap-4">
      {data.skip_reason === null ? null : <SkipReasonNotice reason={data.skip_reason} />}
      {data.verdict?.reason ? (
        <p className="text-sm wrap-break-word text-muted-foreground">
          <span className="font-medium text-foreground">Why: </span>
          {data.verdict.reason}
          {data.verdict.reason_code ? (
            <>
              {" "}
              <code className="font-mono text-xs">{data.verdict.reason_code}</code>
            </>
          ) : null}
        </p>
      ) : null}
      <Attempts
        runId={runId}
        attempts={data.attempts}
        steps={data.steps}
        attemptsTotal={scenario.attempts_total}
      />
      <Link
        href={scenarioRoutes.detail(data.scenario_id)}
        className="w-fit text-sm font-medium underline underline-offset-4"
      >
        View the scenario definition
      </Link>
    </div>
  );
}

export function ScenarioRow({ runId, scenario }: ScenarioRowProps) {
  const [open, setOpen] = useState(false);
  const durationText =
    scenario.duration_ms === null ? "Not finished" : formatDuration(scenario.duration_ms);

  return (
    <li
      data-slot="scenario-row"
      data-run-scenario-id={scenario.id}
      data-status={scenario.status}
      data-verdict={scenario.verdict?.status ?? "none"}
      className="rounded-xl border bg-card text-card-foreground"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-start gap-3 rounded-xl p-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="font-medium wrap-break-word">{scenario.title}</span>
              <span className="text-xs wrap-break-word text-muted-foreground">
                {scenario.role} on {scenario.interface_id}, {scenario.family}
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <RunScenarioStatusBadge status={scenario.status} />
                <ScenarioOutcome scenario={scenario} />
              </span>
            </span>
            <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              <span className="block">
                {scenario.attempts_done} of {scenario.attempts_total} attempts
              </span>
              <span className="block">{durationText}</span>
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pr-3 pb-3 pl-10">
          <ScenarioRowDetails runId={runId} scenario={scenario} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
