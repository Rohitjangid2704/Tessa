"use client";

import { LoaderCircle, Pencil, Trash, Upload } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { DateTime } from "@/components/date-time";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { pluralize } from "@/features/bundles/format";
import { describeApiError } from "@/lib/api/errors";
import { useCan } from "@/lib/auth/can";
import { formatUsd } from "@/lib/format-usd";
import { useDeletePlan, useUpdatePlan } from "../mutations";
import { describePlanSelection } from "../plan-selection";
import type { Plan } from "../types";
import { PlanNameDialog } from "./plan-name-dialog";

export interface SavedPlanCardProps {
  plan: Plan;
  isLoading: boolean;
  loadDisabled: boolean;
  onLoad: (planId: string) => void;
}

const UNTITLED_PLAN = "Untitled plan";

export function SavedPlanCard({ plan, isLoading, loadDisabled, onLoad }: SavedPlanCardProps) {
  const canSave = useCan("plans.save");
  const canDelete = useCan("plans.delete");
  const headingId = useId();
  const rename = useUpdatePlan();
  const remove = useDeletePlan();
  const [renameOpen, setRenameOpen] = useState(false);
  const displayName = plan.name ?? UNTITLED_PLAN;
  const deleteRequestId = readRequestId(remove.error);

  function changeRenameDialog(open: boolean): void {
    setRenameOpen(open);
    if (!open) {
      rename.reset();
    }
  }

  function submitRename(name: string): void {
    rename.mutate(
      { planId: plan.id, update: { name } },
      {
        onSuccess: () => {
          setRenameOpen(false);
          toast.success(`Renamed to "${name}"`);
        },
      },
    );
  }

  return (
    <article
      data-slot="saved-plan"
      data-plan-id={plan.id}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={headingId} className="text-sm font-semibold wrap-break-word">
            {displayName}
          </h3>
          <p className="text-xs text-muted-foreground">
            Saved <DateTime value={plan.created_at} />
          </p>
        </div>
        <Badge variant="secondary" className="tabular-nums">
          {pluralize(plan.cells_total, "cell")}
        </Badge>
      </div>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Selection</dt>
        <dd>{describePlanSelection(plan.selection)}</dd>
        <dt className="text-muted-foreground">Stops at</dt>
        <dd className="tabular-nums">
          {formatUsd(plan.effective_budget.max_usd)} or {plan.effective_budget.max_minutes} min
        </dd>
      </dl>
      {remove.error === null ? null : (
        <Alert variant="destructive" data-slot="delete-plan-alert">
          <AlertDescription>
            <p>Could not delete the plan. {describeApiError(remove.error)}</p>
            {deleteRequestId === null ? null : (
              <p className="font-mono text-xs">Request ID: {deleteRequestId}</p>
            )}
          </AlertDescription>
        </Alert>
      )}
      {canSave || canDelete ? (
        <div className="flex flex-wrap gap-2">
          {canSave ? (
            <>
              <Button
                type="button"
                size="sm"
                disabled={loadDisabled || isLoading}
                aria-busy={isLoading}
                onClick={() => onLoad(plan.id)}
              >
                {isLoading ? (
                  <LoaderCircle
                    aria-hidden="true"
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                ) : (
                  <Upload aria-hidden="true" data-icon="inline-start" />
                )}
                {isLoading ? "Loading" : "Load into builder"}
                <span className="sr-only"> {displayName}</span>
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setRenameOpen(true)}>
                <Pencil aria-hidden="true" data-icon="inline-start" />
                Rename<span className="sr-only"> {displayName}</span>
              </Button>
            </>
          ) : null}
          {canDelete ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline" size="sm" disabled={remove.isPending}>
                  <Trash aria-hidden="true" data-icon="inline-start" />
                  {remove.isPending ? "Deleting" : "Delete"}
                  <span className="sr-only"> {displayName}</span>
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {displayName}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The saved plan is removed. Runs started from it stay in the history but lose
                    the link to the plan.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep plan</AlertDialogCancel>
                  <AlertDialogAction onClick={() => remove.mutate(plan.id)}>
                    Delete plan
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
          {canSave ? (
            <PlanNameDialog
              open={renameOpen}
              onOpenChange={changeRenameDialog}
              title="Rename plan"
              description="The name only changes how the plan is listed. Its selection stays the same."
              submitLabel="Rename"
              pendingLabel="Renaming"
              initialName={plan.name ?? ""}
              isPending={rename.isPending}
              error={rename.error}
              onSubmit={submitRename}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
