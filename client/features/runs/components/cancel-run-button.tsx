"use client";

import { Ban, Hourglass } from "lucide-react";
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
import type { Run } from "@/lib/api/types";
import { useCan } from "@/lib/auth/can";
import { isRunNotCancelable, useCancelRun } from "../mutations";
import { isCancelableRunStatus } from "../run-status";
import { isStoppableKind } from "./stop-run-button";

export function describeCancelError(error: unknown): string {
  if (isRunNotCancelable(error)) {
    return "This run can no longer be canceled. It may have just finished; the page was refreshed.";
  }
  if (isApiError(error) && error.status === 403) {
    return "You do not have permission to cancel runs.";
  }
  return describeApiError(error);
}

export function CancelRunButton({ run }: { run: Run }) {
  const canCancel = useCan("runs.cancel");
  const cancel = useCancelRun(run.id);

  if (!canCancel) {
    return null;
  }

  if (run.status === "canceling") {
    return (
      <Button type="button" variant="outline" size="sm" disabled>
        <Hourglass aria-hidden="true" data-icon="inline-start" />
        Canceling
      </Button>
    );
  }

  if (!isCancelableRunStatus(run.status)) {
    return null;
  }

  return (
    <div className="flex flex-col items-end gap-1" data-slot="cancel-run">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button type="button" variant="destructive" size="sm" disabled={cancel.isPending}>
            <Ban aria-hidden="true" data-icon="inline-start" />
            {cancel.isPending ? "Canceling" : "Cancel run"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this run?</AlertDialogTitle>
            <AlertDialogDescription>
              Scenarios that are running stop at their current step and the rest are skipped. A
              canceled run cannot be resumed.
              {isStoppableKind(run.kind)
                ? " Cancel drops candidates that are not verified yet; use Stop to let them finish verifying."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction onClick={() => cancel.mutate()}>Cancel run</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {cancel.isError ? (
        <p role="alert" className="max-w-xs text-right text-xs text-destructive">
          {describeCancelError(cancel.error)}
        </p>
      ) : null}
    </div>
  );
}
