"use client";

import { CircleStop, Hourglass } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { describeApiError, isApiError } from "@/lib/api/errors";
import type { Run, RunKind } from "@/lib/api/types";
import { useCan } from "@/lib/auth/can";
import { isRunNotStoppable, useStopRun } from "../mutations";
import { isCancelableRunStatus } from "../run-status";

export const STOPPABLE_RUN_KINDS: readonly RunKind[] = ["explore", "simulate", "redteam"];

export function isStoppableKind(kind: RunKind): boolean {
  return STOPPABLE_RUN_KINDS.includes(kind);
}

export function isStopRequested(run: Pick<Run, "stop_requested_at">): boolean {
  return run.stop_requested_at !== null;
}

export function describeStopError(error: unknown): string {
  if (isRunNotStoppable(error)) {
    return "This run can no longer be stopped. It may have just finished; the page was refreshed.";
  }
  if (isApiError(error) && error.status === 403) {
    return "You do not have permission to stop runs.";
  }
  return describeApiError(error);
}

export function StopRunButton({ run }: { run: Run }) {
  const canStop = useCan("runs.stop");
  const stop = useStopRun(run.id);

  if (!canStop || !isStoppableKind(run.kind)) {
    return null;
  }

  if (isStopRequested(run) && isCancelableRunStatus(run.status)) {
    return (
      <Button type="button" variant="outline" size="sm" disabled data-slot="stop-run-pending">
        <Hourglass aria-hidden="true" data-icon="inline-start" />
        Stopping
      </Button>
    );
  }

  if (!isCancelableRunStatus(run.status)) {
    return null;
  }

  return (
    <div className="flex flex-col items-end gap-1" data-slot="stop-run">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button type="button" variant="outline" size="sm" disabled={stop.isPending}>
            <CircleStop aria-hidden="true" data-icon="inline-start" />
            {stop.isPending ? "Stopping" : "Stop"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this run?</AlertDialogTitle>
            <AlertDialogDescription>
              The run stops after the current step. Candidates that were already found are still
              verified, and the run ends as completed. To discard unverified candidates, cancel the
              run instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep going</AlertDialogCancel>
            <AlertDialogAction onClick={() => stop.mutate()}>Stop after this step</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {stop.isError ? (
        <p role="alert" className="max-w-xs text-right text-xs text-destructive">
          {describeStopError(stop.error)}
        </p>
      ) : null}
    </div>
  );
}
