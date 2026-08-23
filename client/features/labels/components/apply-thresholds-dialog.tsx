"use client";

import { useState } from "react";
import { toast } from "sonner";
import { RequiresPermission } from "@/components/requires-permission";
import { readRequestId } from "@/components/states/request-id";
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
import { describeApiError } from "@/lib/api/errors";
import type { CalibrationHeldOut, CalibrationThresholds } from "@/lib/api/types";
import {
  describeKappaChange,
  formatThreshold,
  THRESHOLD_ROWS,
  type ThresholdsInForce,
} from "../fit-model";
import { useApplyFitThresholds } from "../fit-mutations";

export type ApplyThresholdsDialogProps = {
  proposed: CalibrationThresholds;
  current: ThresholdsInForce | undefined;
  heldOut: CalibrationHeldOut | null;
};

export function ApplyThresholdsDialog({ proposed, current, heldOut }: ApplyThresholdsDialogProps) {
  const [open, setOpen] = useState(false);
  const { apply, isPending, error, reset } = useApplyFitThresholds();
  const requestId = readRequestId(error);

  function changeOpen(next: boolean): void {
    if (isPending) {
      return;
    }
    setOpen(next);
    if (!next) {
      reset();
    }
  }

  function confirm(): void {
    apply(proposed, {
      onApplied: () => {
        setOpen(false);
        toast.success("Calibration thresholds applied");
      },
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      <RequiresPermission action="settings.write">
        {({ disabled }) => (
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={disabled || current === undefined}
              data-slot="apply-thresholds"
            >
              Apply these thresholds
            </Button>
          </AlertDialogTrigger>
        )}
      </RequiresPermission>
      <AlertDialogContent data-slot="apply-thresholds-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Apply the proposed thresholds?</AlertDialogTitle>
          <AlertDialogDescription>
            The server did not adopt this fit.{" "}
            {heldOut === null ? "" : describeKappaChange(heldOut)} Applying it changes the
            thresholds for every run from now on.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul aria-label="Threshold changes" className="flex flex-col gap-1 text-sm">
          {THRESHOLD_ROWS.map((row) => (
            <li key={row.key} className="flex flex-wrap justify-between gap-2">
              <span>{row.label}</span>
              <span className="font-mono tabular-nums">
                {current === undefined ? "unknown" : formatThreshold(current[row.key])} to{" "}
                {formatThreshold(proposed[row.key])}
              </span>
            </li>
          ))}
        </ul>
        {error === null ? null : (
          <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
            <p>Could not apply the thresholds. {describeApiError(error)}</p>
            {requestId === null ? null : (
              <p className="font-mono text-xs text-muted-foreground">Request ID: {requestId}</p>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep the current thresholds</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            onClick={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            {isPending ? "Applying" : "Apply thresholds"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
