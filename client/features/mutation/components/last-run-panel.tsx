"use client";

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Play, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef } from "react";
import { DateTime } from "@/components/date-time";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import { coverageRoutes, runRoutes } from "@/lib/routes";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import {
  countOutcomes,
  describeOutcomeCounts,
  elapsedSeconds,
  formatElapsed,
  formatPower,
  isActiveRunStatus,
  outcomeRows,
} from "../model";
import { mutationRunQuery, mutationRunsQuery } from "../queries";
import type { Mutant, MutationRun } from "../types";
import { OutcomeTable } from "./outcome-table";

export type LastRunPanelProps = {
  targetId: string;
  mutants: readonly Mutant[];
  className?: string;
};

function LiveElapsed({ startedAt }: { startedAt: string }) {
  const now = useNow(1000);
  return <span className="tabular-nums">{formatElapsed(elapsedSeconds(startedAt, null, now))}</span>;
}

interface LatestRunProps {
  item: MutationRun;
  mutants: readonly Mutant[];
  targetId: string;
}

function LatestRun({ item, mutants, targetId }: LatestRunProps) {
  const queryClient = useQueryClient();
  const run = useQuery({ ...mutationRunQuery(item.id), initialData: item });
  const wasActive = useRef(false);
  const data = run.data;
  const active = isActiveRunStatus(data.status);

  useEffect(() => {
    if (active) {
      wasActive.current = true;
      return;
    }
    if (wasActive.current) {
      wasActive.current = false;
      void queryClient.invalidateQueries({ queryKey: qk.mutation.all() });
      void queryClient.invalidateQueries({ queryKey: qk.mutants.all() });
    }
  }, [active, queryClient]);

  const mutant = mutants.find((candidate) => candidate.id === data.mutant_id);
  const rows = outcomeRows(mutant?.expected_catchers ?? [], data.outcomes);
  const counts = countOutcomes(data.outcomes);
  const scored = data.outcomes.length;
  const allKilled = !active && data.status === "completed" && scored > 0 && counts.killed === scored;
  const hasSurvivor = !active && counts.survived > 0;

  return (
    <div data-slot="last-run" data-status={data.status} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <RunStatusBadge status={data.status} />
        <span className="font-mono text-sm font-medium wrap-anywhere">
          {mutant?.name ?? "A deleted mutant"}
        </span>
        <span className="text-sm text-muted-foreground">
          Started <DateTime value={data.started_at} />
        </span>
        <span className="text-sm text-muted-foreground">
          {active ? "Running for " : "Took "}
          {active ? (
            <LiveElapsed startedAt={data.started_at} />
          ) : (
            <span className="tabular-nums">
              {formatElapsed(elapsedSeconds(data.started_at, data.finished_at, null))}
            </span>
          )}
        </span>
        <Button asChild variant="outline" size="sm" className="ml-auto">
          <Link href={runRoutes.detail(data.run_id)}>
            {active ? "Watch the run live" : "Open the run"}
          </Link>
        </Button>
      </div>
      <p role="status" data-slot="run-progress" className="text-sm text-muted-foreground">
        {active
          ? `Scoring invariants: ${scored} of ${rows.length} done.`
          : `Finished. ${describeOutcomeCounts(data.outcomes)}. ${formatPower(data.power)}.`}
      </p>
      {run.isError ? (
        <Alert variant="destructive" data-slot="run-poll-error">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Could not refresh this run</AlertTitle>
          <AlertDescription>
            <p>{describeApiError(run.error)}</p>
            {readRequestId(run.error) === null ? null : (
              <p className="font-mono text-xs">Request ID: {readRequestId(run.error)}</p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void run.refetch()}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {data.status === "failed" ? (
        <Alert variant="destructive" data-slot="run-failed">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>The mutation run failed</AlertTitle>
          <AlertDescription>
            The run ended before every invariant was scored, so this mutant is not counted. Open the
            run to read why, check that the mutant answers at its base URL, and run it again.
          </AlertDescription>
        </Alert>
      ) : null}
      {data.status === "canceled" || data.status === "budget_exceeded" ? (
        <Alert role="status" data-slot="run-partial">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>
            {data.status === "canceled" ? "The run was canceled" : "The run ran out of budget"}
          </AlertTitle>
          <AlertDescription>
            The outcomes below are partial. Run the mutant again for a full result.
          </AlertDescription>
        </Alert>
      ) : null}
      <OutcomeTable rows={rows} active={active} />
      {allKilled ? (
        <p data-slot="run-all-killed" className="flex items-center gap-2 text-sm">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-kpi-good-fg" />
          Every scored invariant caught this mutant.
        </p>
      ) : null}
      {hasSurvivor ? (
        <div data-slot="run-survived" className="flex flex-col gap-2 text-sm">
          <p className="flex items-start gap-2">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-kpi-warn-fg" />
            <span>
              {counts.survived} {counts.survived === 1 ? "invariant" : "invariants"} did not catch
              this mutant, so the suite has a blind spot for this bug.
            </span>
          </p>
          <div>
            <Button asChild variant="outline" size="sm">
              <Link href={coverageRoutes.map(targetId)}>Open the coverage map</Link>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function LastRunPanel({ targetId, mutants, className }: LastRunPanelProps) {
  const headingId = useId();
  const history = useInfiniteQuery(mutationRunsQuery(targetId));
  const latest = history.data?.items[0];

  function renderBody() {
    if (history.isPending) {
      return (
        <div role="status" aria-busy="true" className="flex flex-col gap-3">
          <span className="sr-only">Loading the last mutation run</span>
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      );
    }
    if (history.isError) {
      return (
        <ErrorState
          title="Could not load the mutation runs"
          description={describeApiError(history.error)}
          requestId={readRequestId(history.error)}
          onRetry={() => void history.refetch()}
          className="py-8"
        />
      );
    }
    if (latest === undefined) {
      return (
        <EmptyState
          icon={Play}
          title="No mutation run yet"
          description={
            mutants.some((mutant) => mutant.status === "deployed")
              ? "Press Run on a deployed mutant in the table above. The outcome of each invariant shows up here while the run is going."
              : "A mutant must be deployed to QA and marked deployed before it can run. Mark one deployed in the table above."
          }
          className="py-10"
        />
      );
    }
    return <LatestRun key={latest.id} item={latest} mutants={mutants} targetId={targetId} />;
  }

  return (
    <section
      aria-labelledby={headingId}
      data-slot="last-run-panel"
      className={cn("flex flex-col gap-3", className)}
    >
      <h2 id={headingId} className="text-base font-semibold">
        Last mutation run
      </h2>
      {renderBody()}
    </section>
  );
}
