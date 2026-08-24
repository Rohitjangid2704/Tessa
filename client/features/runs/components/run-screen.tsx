"use client";

import Link from "next/link";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { runRoutes } from "@/lib/routes";
import { RunKindBody } from "../kind-views/run-kind-body";
import { RunHeader } from "../run-header";
import { useRunStreamState } from "../use-run-stream";

function BackToRuns() {
  return (
    <Button asChild variant="outline">
      <Link href={runRoutes.list()}>Back to runs</Link>
    </Button>
  );
}

export function RunLoading() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">Loading the run</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-5 w-80 max-w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function RunNotFound({ requestId = null }: { requestId?: string | null }) {
  return (
    <ErrorState
      title="Run not found"
      description="This run does not exist or was removed. Pick another one from the runs list."
      requestId={requestId}
      action={<BackToRuns />}
    />
  );
}

export function RunScreen({ runId }: { runId: string }) {
  const { phase, error, retry } = useRunStreamState();

  switch (phase) {
    case "loading":
      return <RunLoading />;
    case "not_found":
      return <RunNotFound requestId={readRequestId(error)} />;
    case "error":
      return (
        <ErrorState
          title="Could not load the run"
          description={describeApiError(error)}
          requestId={readRequestId(error)}
          onRetry={retry}
          action={<BackToRuns />}
        />
      );
    case "ready":
      return (
        <div className="flex flex-col gap-6">
          <RunHeader />
          <RunKindBody runId={runId} />
        </div>
      );
  }
}
