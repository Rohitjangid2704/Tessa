"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Play, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/states/error-state";
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
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { savedPlansQuery } from "@/features/plans/queries";
import type { Target } from "@/features/targets/types";
import { describeApiError } from "@/lib/api/errors";
import { useCanDo } from "@/lib/auth/can";
import { catalogRoutes } from "@/lib/routes";
import { describeMutationRunError } from "../errors";
import { mutantRunBlock } from "../model";
import { useStartMutationRun } from "../mutations";
import { NO_PLAN_REASON } from "../schemas";
import type { Mutant, MutationRunCreate } from "../types";

const URL_PATTERN = /^https?:\/\/\S+$/;
const UNTITLED_PLAN = "Untitled plan";

export interface RunMutationDialogProps {
  target: Pick<Target, "id" | "name" | "tier" | "archived_at">;
  mutant: Mutant;
  onClose: () => void;
}

function overrideProblem(override: string): string | null {
  const trimmed = override.trim();
  if (trimmed === "") {
    return null;
  }
  return URL_PATTERN.test(trimmed) ? null : "Enter a URL that starts with http:// or https://.";
}

export function RunMutationDialog({ target, mutant, onClose }: RunMutationDialogProps) {
  const baseId = useId();
  const runAccess = useCanDo("mutation.run");
  const plans = useInfiniteQuery(savedPlansQuery(target.id));
  const [pickedPlanId, setPickedPlanId] = useState<string | null>(null);
  const [override, setOverride] = useState("");
  const [attempted, setAttempted] = useState(false);
  const run = useStartMutationRun({
    onStarted: () => {
      toast.success(`Mutation run started for ${mutant.name}`);
      onClose();
    },
  });

  const planList = plans.data?.items ?? [];
  const planId = pickedPlanId ?? planList[0]?.id ?? null;
  const blockReason = mutantRunBlock(mutant, target)?.reason ?? null;
  const overrideError = attempted ? overrideProblem(override) : null;
  const problem = run.error === null || run.error === undefined ? null : describeMutationRunError(run.error);
  const fieldProblem = problem?.field === "base_url_override" ? problem : null;
  const alertProblem = problem !== null && fieldProblem === null ? problem : null;
  const planFieldId = `${baseId}-plan`;
  const overrideId = `${baseId}-override`;
  const overrideNoteId = `${overrideId}-note`;
  const overrideErrorId = `${overrideId}-error`;
  const overrideShownError = overrideError ?? fieldProblem?.message ?? null;
  const submitDisabled =
    !runAccess.allowed || blockReason !== null || planId === null || run.isPending;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAttempted(true);
    if (
      !runAccess.allowed ||
      blockReason !== null ||
      planId === null ||
      overrideProblem(override) !== null ||
      run.isPending
    ) {
      return;
    }
    const trimmed = override.trim();
    const body: MutationRunCreate = {
      target_id: target.id,
      mutant_id: mutant.id,
      plan_id: planId,
      ...(trimmed === "" ? {} : { base_url_override: trimmed }),
    };
    run.start(body);
  }

  function renderPlanField() {
    if (plans.isPending) {
      return (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading the saved plans</span>
          <Skeleton className="h-8 w-full" />
        </div>
      );
    }
    if (plans.isError) {
      return (
        <ErrorState
          title="Could not load the saved plans"
          description={describeApiError(plans.error)}
          requestId={readRequestId(plans.error)}
          onRetry={() => void plans.refetch()}
          className="py-6"
        />
      );
    }
    if (planList.length === 0) {
      return (
        <p role="note" data-slot="no-plans" className="text-sm text-muted-foreground">
          {NO_PLAN_REASON}{" "}
          <Link href={catalogRoutes.plans(target.id)} className="underline underline-offset-3">
            Open the saved plans
          </Link>
          .
        </p>
      );
    }
    return (
      <Field>
        <FieldLabel htmlFor={planFieldId}>Plan to run</FieldLabel>
        <Select
          value={planId ?? undefined}
          onValueChange={setPickedPlanId}
          disabled={run.isPending || blockReason !== null}
        >
          <SelectTrigger id={planFieldId} className="w-full">
            <SelectValue placeholder="Choose a saved plan" />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {planList.map((plan) => (
              <SelectItem key={plan.id} value={plan.id}>
                {plan.name ?? UNTITLED_PLAN}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          The same suite that runs nightly. It runs once against the mutant.
        </FieldDescription>
      </Field>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run {mutant.name}</DialogTitle>
          <DialogDescription>
            Runs a saved plan against the deployed mutant. Each expected invariant is scored killed
            when a scenario fails on it and survived when none does.
          </DialogDescription>
        </DialogHeader>
        {blockReason === null ? null : (
          <Alert role="status" data-slot="run-blocked" data-reason="blocked">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>This mutant cannot run</AlertTitle>
            <AlertDescription>{blockReason}</AlertDescription>
          </Alert>
        )}
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Branch</dt>
          <dd className="font-mono text-xs wrap-anywhere">{mutant.branch}</dd>
          <dt className="text-muted-foreground">Deployed at</dt>
          <dd className="font-mono text-xs wrap-anywhere">{mutant.base_url ?? "Not deployed"}</dd>
          <dt className="text-muted-foreground">Should be caught by</dt>
          <dd className="font-mono text-xs wrap-anywhere">{mutant.expected_catchers.join(", ")}</dd>
        </dl>
        <form
          id={`${baseId}-form`}
          noValidate
          autoComplete="off"
          onSubmit={handleSubmit}
          aria-label={`Run ${mutant.name}`}
          className="flex flex-col gap-4"
        >
          {renderPlanField()}
          <Field data-invalid={overrideShownError === null ? undefined : true}>
            <FieldLabel htmlFor={overrideId}>Base URL override (optional)</FieldLabel>
            <Input
              id={overrideId}
              value={override}
              disabled={run.isPending || blockReason !== null}
              placeholder={mutant.base_url ?? "https://mutant.qa.example.test"}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={overrideShownError === null ? undefined : true}
              aria-describedby={[overrideNoteId, overrideShownError === null ? null : overrideErrorId]
                .filter((entry) => entry !== null)
                .join(" ")}
              onChange={(event) => {
                setOverride(event.target.value);
                if (run.error !== null && run.error !== undefined) {
                  run.reset();
                }
              }}
            />
            <FieldDescription id={overrideNoteId}>
              Leave it empty to run against the URL above. An override must point at a QA copy of
              the mutant and may not be a production system: the server refuses a production URL.
            </FieldDescription>
            {overrideShownError === null ? null : (
              <FieldError id={overrideErrorId}>{overrideShownError}</FieldError>
            )}
          </Field>
        </form>
        {alertProblem === null ? null : (
          <Alert variant="destructive" data-slot="run-error" data-kind={alertProblem.kind}>
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{alertProblem.title}</AlertTitle>
            <AlertDescription>
              <p>{alertProblem.message}</p>
              {alertProblem.issues.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
              {readRequestId(run.error) === null ? null : (
                <p className="font-mono text-xs">Request ID: {readRequestId(run.error)}</p>
              )}
            </AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={`${baseId}-form`}
            disabled={submitDisabled}
            aria-busy={run.isPending}
          >
            <Play aria-hidden="true" data-icon="inline-start" />
            {run.isPending ? "Starting" : "Start mutation run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
