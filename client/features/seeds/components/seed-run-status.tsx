"use client";

import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { DateTime } from "@/components/date-time";
import { readRequestId } from "@/components/states/request-id";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError, isApiError } from "@/lib/api/errors";
import type { Run } from "@/lib/api/types";
import { runRoutes } from "@/lib/routes";
import type { useSeedRun } from "../use-seed-run";

export type SeedRunState = ReturnType<typeof useSeedRun>;

export function describeSeedRun(run: Pick<Run, "status">): string {
  switch (run.status) {
    case "queued":
      return "The seed run is queued.";
    case "planning":
    case "seeding":
    case "running":
      return "The seed run is working. This page checks again until it finishes.";
    case "canceling":
      return "The seed run is being canceled.";
    case "completed":
      return "The seed run finished. The result is in the comparison above.";
    case "failed":
      return "The seed run failed.";
    case "canceled":
      return "The seed run was canceled before it finished.";
    case "budget_exceeded":
      return "The seed run stopped at its budget.";
  }
}

export interface SeedRunStatusProps {
  runId: string;
  state: SeedRunState;
}

export function SeedRunStatus({ runId, state }: SeedRunStatusProps) {
  const { query, run, notASeedRun, active } = state;

  if (query.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        data-slot="seed-run-status"
        className="flex flex-col gap-2 rounded-xl border p-4"
      >
        <span className="sr-only">Starting the seed run</span>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
    );
  }

  if (query.isError) {
    const missing = isApiError(query.error) && [404, 422].includes(query.error.status);
    return (
      <Alert variant="destructive" data-slot="seed-run-status" data-state="error">
        <AlertTitle>{missing ? "Seed run not found" : "Could not read the seed run"}</AlertTitle>
        <AlertDescription>
          <p>
            {missing
              ? "This run does not exist any more. Start Verify or Reset again."
              : describeApiError(query.error)}
            {readRequestId(query.error) === null
              ? null
              : ` Request ID: ${readRequestId(query.error)}`}
          </p>
          {missing ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void query.refetch()}
            >
              Try again
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  if (notASeedRun || run === undefined) {
    return (
      <Alert variant="destructive" data-slot="seed-run-status" data-state="error">
        <AlertTitle>Not a seed run</AlertTitle>
        <AlertDescription>
          The run in the address is not a seed run, so it is not shown here.{" "}
          <Link href={runRoutes.detail(runId)} className="font-medium underline">
            Open it as a run
          </Link>
          .
        </AlertDescription>
      </Alert>
    );
  }

  const failed = run.status === "failed";
  const message = describeSeedRun(run);
  return (
    <section
      data-slot="seed-run-status"
      data-state={run.status}
      aria-label="Seed run"
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Seed run</h3>
        <RunStatusBadge status={run.status} />
        <span className="text-xs text-muted-foreground">
          Started <DateTime value={run.started_at ?? run.created_at} />
        </span>
        {run.finished_at === null ? null : (
          <span className="text-xs text-muted-foreground">
            Finished <DateTime value={run.finished_at} />
          </span>
        )}
        <Button asChild variant="outline" size="sm" className="ml-auto">
          <Link href={runRoutes.detail(run.id)}>Open the run</Link>
        </Button>
      </div>
      {failed ? (
        <Alert variant="destructive" data-slot="seed-run-failed">
          <AlertTitle>The seed run failed</AlertTitle>
          <AlertDescription>
            The data may not be in the seed state. Open the run to see which phase failed and the
            hashes it compared.
          </AlertDescription>
        </Alert>
      ) : (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          {active ? (
            <LoaderCircle
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
          ) : null}
          {message}
        </p>
      )}
    </section>
  );
}
