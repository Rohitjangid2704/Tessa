"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { LoaderCircle, Play, RefreshCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TierChip } from "@/features/targets/components/tier-chip";
import { targetOptionsQuery } from "@/features/targets/queries";
import type { TargetTier } from "@/features/targets/types";
import { describeApiError } from "@/lib/api/errors";
import type { Plan } from "@/lib/api/types";
import { useCan } from "@/lib/auth/can";
import { catalogRoutes } from "@/lib/routes";
import { classifyRunGroupError } from "../run-groups/errors";
import { useStartRunGroup } from "../run-groups/mutations";
import { runGroupPlansQuery } from "../run-groups/queries";
import { RUN_GROUP_PLANS_LIMIT, runGroupSchema } from "../run-groups/schemas";

const SHORT_ID_LENGTH = 8;
const NO_PLANS: Readonly<Record<string, string>> = {};

export type RunGroupDialogProps = {
  targetIds: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPlanIds?: Readonly<Record<string, string>>;
};

type RunGroupRow = {
  targetId: string;
  name: string;
  tier: TargetTier | null;
  plans: readonly Plan[] | undefined;
  hasMorePlans: boolean;
  isLoadingPlans: boolean;
  plansError: unknown;
  planId: string | undefined;
  retryPlans: () => void;
};

function effectivePlanId(
  candidate: string | undefined,
  plans: readonly Plan[] | undefined,
): string | undefined {
  if (plans === undefined) {
    return undefined;
  }
  if (candidate !== undefined && plans.some((plan) => plan.id === candidate)) {
    return candidate;
  }
  return plans.length === 1 ? plans[0]?.id : undefined;
}

function planLabel(plan: Plan): string {
  const cells = plan.cells_total === 1 ? "1 cell" : `${plan.cells_total} cells`;
  return `${plan.name ?? "Untitled plan"} (${cells})`;
}

type PlanRowProps = {
  row: RunGroupRow;
  disabled: boolean;
  notice: string | undefined;
  onChange: (planId: string) => void;
};

function PlanRow({ row, disabled, notice, onChange }: PlanRowProps) {
  const selectId = useId();
  const noticeId = `${selectId}-notice`;
  const plans = row.plans ?? [];
  return (
    <li data-slot="run-group-row" data-target-id={row.targetId} className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={selectId}>Plan for {row.name}</Label>
        {row.tier === null ? null : <TierChip tier={row.tier} />}
      </div>
      {row.isLoadingPlans ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading the saved plans of {row.name}</span>
          <Skeleton aria-hidden="true" className="h-8 w-full" />
        </div>
      ) : row.plansError !== null && row.plansError !== undefined ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>Could not load the saved plans. {describeApiError(row.plansError)}</span>
          <Button type="button" variant="outline" size="sm" onClick={row.retryPlans}>
            <RefreshCw aria-hidden="true" data-icon="inline-start" />
            Retry
          </Button>
        </div>
      ) : plans.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {row.name} has no saved plan.{" "}
          <Link
            href={catalogRoutes.plans(row.targetId)}
            className="underline underline-offset-3"
          >
            Save one in the catalog
          </Link>
        </p>
      ) : (
        <Select value={row.planId ?? ""} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger
            id={selectId}
            className="w-full"
            aria-invalid={notice === undefined ? undefined : true}
            aria-describedby={notice === undefined ? undefined : noticeId}
          >
            <SelectValue placeholder="Choose a saved plan" />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {plans.map((plan) => (
              <SelectItem key={plan.id} value={plan.id}>
                {planLabel(plan)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {row.hasMorePlans ? (
        <p className="text-xs text-muted-foreground">
          Showing the first {RUN_GROUP_PLANS_LIMIT} saved plans.
        </p>
      ) : null}
      {row.tier === "production" ? (
        <p className="text-xs text-muted-foreground">
          Production target: its run stays read-only and needs production runs enabled.
        </p>
      ) : null}
      {notice === undefined ? null : (
        <p id={noticeId} role="alert" className="text-xs text-destructive">
          {notice}
        </p>
      )}
    </li>
  );
}

function RunGroupForm({
  targetIds,
  initialPlanIds = NO_PLANS,
  onOpenChange,
}: Omit<RunGroupDialogProps, "open">) {
  const canStart = useCan("runs.start_group");
  const targets = useQuery(targetOptionsQuery());
  const planQueries = useQueries({
    queries: targetIds.map((targetId) => runGroupPlansQuery(targetId)),
  });
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const mutation = useStartRunGroup({ onStarted: () => onOpenChange(false) });

  const rows: RunGroupRow[] = targetIds.map((targetId, index) => {
    const summary = targets.data?.find((target) => target.id === targetId);
    const query = planQueries[index];
    const plans = query?.data?.items;
    return {
      targetId,
      name: summary?.name ?? `Target ${targetId.slice(0, SHORT_ID_LENGTH)}`,
      tier: summary?.tier ?? null,
      plans,
      hasMorePlans: query?.data?.next_cursor != null,
      isLoadingPlans: query === undefined || query.isPending,
      plansError: query?.error ?? null,
      planId: effectivePlanId(chosen[targetId] ?? initialPlanIds[targetId], plans),
      retryPlans: () => void query?.refetch(),
    };
  });

  const planIds = rows.flatMap((row) => (row.planId === undefined ? [] : [row.planId]));
  const parsed = runGroupSchema.safeParse({ plan_ids: planIds });
  const missingRow = rows.find((row) => row.planId === undefined);
  const blocker = !canStart
    ? "Starting a run group needs the member role."
    : missingRow !== undefined
      ? missingRow.plans?.length === 0
        ? `${missingRow.name} has no saved plan.`
        : `Choose a plan for ${missingRow.name}.`
      : parsed.success
        ? null
        : (parsed.error.issues[0]?.message ?? "Pick the targets and their plans.");
  const submitDisabled = mutation.isPending || blocker !== null;

  const problem =
    mutation.error === null
      ? null
      : classifyRunGroupError(
          mutation.error,
          rows.map((row) => row.name),
        );
  const requestId = mutation.error === null ? null : readRequestId(mutation.error);

  function rowNotice(index: number): string | undefined {
    if (problem === null) {
      return undefined;
    }
    if (problem.kind === "invalid") {
      return problem.rowMessages[index];
    }
    return problem.kind === "production_blocked" && problem.rowIndex === index
      ? "Production runs are not allowed for this target yet."
      : undefined;
  }

  function choosePlan(targetId: string, planId: string): void {
    mutation.reset();
    setChosen((previous) => ({ ...previous, [targetId]: planId }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (submitDisabled || !parsed.success) {
      return;
    }
    mutation.start(parsed.data);
  }

  return (
    <form
      aria-label="Start a run group"
      noValidate
      onSubmit={handleSubmit}
      className="flex flex-col gap-4"
    >
      <DialogHeader>
        <DialogTitle>Run on {targetIds.length} targets</DialogTitle>
        <DialogDescription>
          Pick one saved plan for each target. The runs start together and are tracked as one
          group.
        </DialogDescription>
      </DialogHeader>
      <fieldset disabled={mutation.isPending} className="flex min-w-0 flex-col gap-4 border-0 p-0">
        <ul aria-label="Plan for each target" className="flex flex-col gap-4">
          {rows.map((row, index) => (
            <PlanRow
              key={row.targetId}
              row={row}
              disabled={!canStart || mutation.isPending}
              notice={rowNotice(index)}
              onChange={(planId) => choosePlan(row.targetId, planId)}
            />
          ))}
        </ul>
      </fieldset>
      {canStart ? null : (
        <p role="status" data-slot="viewer-note" className="text-sm text-muted-foreground">
          You can read this page. Starting a run group needs the member or admin role.
        </p>
      )}
      {problem === null ? null : (
        <Alert variant="destructive" data-slot="run-group-error" data-problem={problem.kind}>
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{problem.title}</AlertTitle>
          <AlertDescription>
            <p>{problem.message}</p>
            {problem.issues.length > 0 ? (
              <ul className="list-disc pl-5">
                {problem.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : null}
            {requestId === null ? null : (
              <p className="font-mono text-xs">Request ID: {requestId}</p>
            )}
          </AlertDescription>
        </Alert>
      )}
      <DialogFooter className="items-center">
        {blocker === null ? null : (
          <p data-slot="run-group-blocker" className="mr-auto text-sm text-muted-foreground">
            {blocker}
          </p>
        )}
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitDisabled} aria-busy={mutation.isPending}>
          {mutation.isPending ? (
            <LoaderCircle
              aria-hidden="true"
              data-icon="inline-start"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : (
            <Play aria-hidden="true" data-icon="inline-start" />
          )}
          {mutation.isPending ? "Starting" : "Start run group"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RunGroupDialog({ open, onOpenChange, ...form }: RunGroupDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <RunGroupForm onOpenChange={onOpenChange} {...form} />
      </DialogContent>
    </Dialog>
  );
}
