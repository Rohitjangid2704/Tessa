"use client";

import { useQuery } from "@tanstack/react-query";
import { HeartPulse, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { targetRoutes } from "@/lib/routes";
import { describeHealthFailure } from "../errors";
import { useRunHealthChecks } from "../mutations";
import { healthReportQuery } from "../queries";
import { HealthStrip, summarizeHealth } from "./health-strip";

export type HealthReadOnlyReason = "role" | "archived" | null;

export interface HealthPanelProps {
  targetId: string;
  readOnlyReason: HealthReadOnlyReason;
}

function IndeterminateProgress() {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="progressbar"
        aria-label="Running health checks"
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full w-full bg-primary motion-safe:animate-pulse" />
      </div>
      <p className="text-xs text-muted-foreground">
        Checking every interface. This can take up to 10 s per interface.
      </p>
    </div>
  );
}

function readOnlyNote(reason: Exclude<HealthReadOnlyReason, null>): string {
  return reason === "archived"
    ? "This target is archived, so health checks cannot run. The last stored result is shown."
    : "Members and admins can run health checks. The last stored result is shown.";
}

export function HealthPanel({ targetId, readOnlyReason }: HealthPanelProps) {
  const stored = useQuery(healthReportQuery(targetId));
  const run = useRunHealthChecks(targetId);
  const failure = run.isError ? describeHealthFailure(run.error) : null;
  const report = stored.data;
  const announcement = run.isPending
    ? "Running health checks"
    : run.isSuccess
      ? `Health checks finished: ${summarizeHealth(run.data.interfaces)}`
      : "";

  return (
    <div data-slot="health-panel" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={readOnlyReason !== null || run.isPending}
          onClick={() => run.mutate()}
        >
          <HeartPulse aria-hidden="true" data-icon="inline-start" />
          {run.isPending ? "Running health checks" : "Run health checks"}
        </Button>
        <p className="max-w-xl text-sm text-muted-foreground">
          Checks run against the saved values. Save your changes first.
        </p>
      </div>
      {readOnlyReason === null ? null : (
        <p data-slot="read-only-notice" className="text-sm text-muted-foreground">
          {readOnlyNote(readOnlyReason)}
        </p>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {run.isPending ? <IndeterminateProgress /> : null}
      {failure === null ? null : (
        <Alert variant="destructive" data-slot="health-failure">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>
            <p>{failure.message}</p>
            {failure.notReady ? (
              <p>
                <Link
                  href={targetRoutes.bundles(targetId)}
                  className="underline underline-offset-3"
                >
                  Upload a bundle
                </Link>
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      )}
      {report !== undefined ? (
        <HealthStrip report={report} isRunning={run.isPending} />
      ) : stored.isError ? (
        <ErrorState
          title="Could not load the last health check"
          description={describeApiError(stored.error)}
          requestId={readRequestId(stored.error)}
          onRetry={() => void stored.refetch()}
          className="py-8"
        />
      ) : (
        <div role="status" aria-busy="true" className="flex flex-col gap-2">
          <span className="sr-only">Loading the last health check</span>
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
    </div>
  );
}
