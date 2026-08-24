"use client";

import { useQuery } from "@tanstack/react-query";
import { Bug, GitCompareArrows, Hourglass, TriangleAlert, Wallet } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { DateTime } from "@/components/date-time";
import { Meter } from "@/components/meter";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import type { Run, RunStats } from "@/lib/api/types";
import { findingRoutes, runRoutes } from "@/lib/routes";
import { formatCount, formatPercent } from "../results-format";
import { runStatsQuery } from "../stats-queries";
import { useRunStreamState } from "../use-run-stream";
import { FamilyPasskTable } from "./family-passk-table";
import { InvariantPanel } from "./invariant-panel";
import { PercentileTiles } from "./percentile-tiles";
import { TierMixBar } from "./tier-mix-bar";

function ResultsSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">Loading the run results</span>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

type SummaryTileProps = {
  label: string;
  children: ReactNode;
};

function SummaryTile({ label, children }: SummaryTileProps) {
  return (
    <div
      data-slot="summary-tile"
      className="flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card px-4 py-3"
    >
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex flex-col gap-1.5 text-2xl font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

function RunSummary({ stats, run }: { stats: RunStats; run: Run | undefined }) {
  return (
    <dl data-slot="results-summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryTile label="Attempts per scenario (k)">
        <span data-slot="results-k">{stats.k}</span>
      </SummaryTile>
      <SummaryTile label={`pass^${stats.k} overall`}>
        <span data-slot="results-pass-hat-k">{formatPercent(stats.pass_hat_k)}</span>
        <Meter value={stats.pass_hat_k} label={`Overall pass^${stats.k}`} />
      </SummaryTile>
      <SummaryTile label="Flaky rate">
        <span data-slot="results-flaky-rate">{formatPercent(stats.flaky_rate)}</span>
      </SummaryTile>
      <SummaryTile label="Open findings">
        <span data-slot="results-open-findings">{formatCount(stats.open_findings)}</span>
        {run === undefined ? null : (
          <Link
            href={findingRoutes.list({ run_id: run.id, target_id: run.target_id })}
            className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
          >
            <Bug aria-hidden="true" className="size-3.5" />
            View findings
          </Link>
        )}
      </SummaryTile>
    </dl>
  );
}

type ResultsNoticeProps = {
  status: Run["status"] | undefined;
  updatedAt: string | null;
};

function ResultsNotice({ status, updatedAt }: ResultsNoticeProps) {
  if (status === undefined) {
    return null;
  }
  if (status === "budget_exceeded") {
    return (
      <Alert role="status" data-slot="results-budget-exceeded">
        <Wallet aria-hidden="true" />
        <AlertTitle>Budget exceeded</AlertTitle>
        <AlertDescription>
          The run stopped at its budget, so these results cover only the scenarios that ran.
          Scenarios that did not start are counted as skipped.
        </AlertDescription>
      </Alert>
    );
  }
  if (status === "failed" || status === "canceled") {
    return (
      <Alert role="status" data-slot="results-incomplete">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>{status === "failed" ? "Run failed" : "Run canceled"}</AlertTitle>
        <AlertDescription>
          These results cover only what finished before the run ended. Scenarios that did not
          finish are not counted as passes.
        </AlertDescription>
      </Alert>
    );
  }
  if (status === "completed") {
    return null;
  }
  return (
    <Alert role="status" data-slot="results-partial">
      <Hourglass aria-hidden="true" />
      <AlertTitle>Partial results</AlertTitle>
      <AlertDescription>
        The run is still going. These numbers refresh about every 5 seconds and when a scenario
        finishes.
        {updatedAt === null ? null : (
          <>
            {" "}
            Updated <DateTime value={updatedAt} />.
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function RunResults({ runId }: { runId: string }) {
  const { run, isTerminal } = useRunStreamState();
  const query = useQuery(runStatsQuery(runId, !isTerminal));

  if (query.isPending) {
    return <ResultsSkeleton />;
  }
  if (query.data === undefined) {
    return (
      <ErrorState
        title="Could not load the run results"
        description={describeApiError(query.error)}
        requestId={readRequestId(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const stats = query.data;
  const updatedAt = query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt).toISOString() : null;
  const hasFamilies = stats.families.length > 0;

  return (
    <div
      data-slot="run-results"
      data-partial={isTerminal ? "false" : "true"}
      className="flex flex-col gap-6"
    >
      <ResultsNotice status={run?.status} updatedAt={updatedAt} />
      {query.isError ? (
        <Alert role="status" variant="destructive" data-slot="results-refresh-error">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Could not refresh the results</AlertTitle>
          <AlertDescription>
            <p>{describeApiError(query.error)} The numbers below are the last ones received.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {run?.plan_id ? (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link href={runRoutes.diff(run.id)}>
              <GitCompareArrows aria-hidden="true" data-icon="inline-start" />
              Compare with another run
            </Link>
          </Button>
        </div>
      ) : null}
      <RunSummary stats={stats} run={run} />
      <section aria-labelledby="families-heading" className="flex flex-col gap-2">
        <h3 id="families-heading" className="text-sm font-semibold">
          Families
        </h3>
        {hasFamilies ? (
          <FamilyPasskTable families={stats.families} k={stats.k} />
        ) : (
          <EmptyState
            title="No scenarios have finished yet"
            description="Families appear here as soon as the first scenario finishes."
            className="py-10"
          />
        )}
      </section>
      <PercentileTiles latency={stats.latency_ms} cost={stats.cost_usd} />
      <TierMixBar tiers={stats.tiers} />
      <InvariantPanel runId={runId} invariants={stats.invariants} />
    </div>
  );
}
