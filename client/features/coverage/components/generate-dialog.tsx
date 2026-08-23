"use client";

import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, Sparkles, TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
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
import { pluralize } from "@/features/bundles/format";
import { hasBudgetErrors, resolveBudgetInput } from "@/features/plans/budget-input";
import { BudgetFields } from "@/features/plans/components/budget-fields";
import { DepthPicker } from "@/features/plans/components/depth-picker";
import { settingsQuery } from "@/features/settings/queries";
import { formatUsd } from "@/lib/format-usd";
import { generateBlockedReason, type CoverageAccess } from "../access";
import { classifyGenerateError } from "../generate-errors";
import { useGenerateCoverage } from "../mutations";
import type { Budget, CoverageCell, Depth, RunHandle } from "../types";

export interface GenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planId: string;
  cells: readonly CoverageCell[];
  access: CoverageAccess;
  onStarted: (handle: RunHandle) => void;
}

type GenerateFormProps = Omit<GenerateDialogProps, "open">;

function describeEstimate(depth: Depth, perCellUsd: number | undefined, cellCount: number) {
  if (depth === "smoke") {
    return "Smoke is free: the scenarios come from the bundle examples and no model is called.";
  }
  if (perCellUsd === undefined) {
    return "The cost estimate appears once the settings have loaded.";
  }
  return `Up to about ${formatUsd(perCellUsd * cellCount)} (${formatUsd(perCellUsd)} per cell for ${pluralize(cellCount, "cell")}). This is an estimate for display; the budget below is what stops the run.`;
}

function GenerateForm({ onOpenChange, planId, cells, access, onStarted }: GenerateFormProps) {
  const settings = useQuery(settingsQuery());
  const generation = useGenerateCoverage();
  const [depth, setDepth] = useState<Depth>("smoke");
  const [maxUsd, setMaxUsd] = useState("");
  const [maxMinutes, setMaxMinutes] = useState("");

  const settingsBudget: Budget | null =
    settings.data === undefined
      ? null
      : {
          max_usd: settings.data.budgets.default_max_usd,
          max_minutes: settings.data.budgets.default_max_minutes,
        };
  const resolution = resolveBudgetInput({ maxUsd, maxMinutes }, settingsBudget);
  const budgetBlocked = hasBudgetErrors(resolution.errors);
  const blockedReason = generateBlockedReason(access);
  const problem = generation.error === null ? null : classifyGenerateError(generation.error);
  const requestId = readRequestId(generation.error);
  const perCellUsd = settings.data?.models.generate?.max_usd;

  function edit(change: () => void): void {
    if (generation.error !== null) {
      generation.reset();
    }
    change();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (blockedReason !== null || budgetBlocked || cells.length === 0) {
      return;
    }
    generation.generate(
      {
        planId,
        cellIds: cells.map((cell) => cell.id),
        depth,
        budget: resolution.budget,
      },
      {
        onSuccess: (handle) => {
          onStarted(handle);
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Generate scenarios here</DialogTitle>
        <DialogDescription>
          Tessa writes scenarios for {pluralize(cells.length, "empty cell")} on the server.
          Generated scenarios wait in the review queue until a person accepts them.
        </DialogDescription>
      </DialogHeader>
      <DepthPicker
        value={depth}
        disabled={generation.isPending}
        onChange={(next) => edit(() => setDepth(next))}
      />
      <p role="status" data-slot="generate-estimate" className="text-sm text-muted-foreground">
        {describeEstimate(depth, perCellUsd, cells.length)}
      </p>
      <BudgetFields
        maxUsd={maxUsd}
        maxMinutes={maxMinutes}
        placeholders={settingsBudget}
        errors={resolution.errors}
        disabled={generation.isPending}
        onMaxUsdChange={(value) => edit(() => setMaxUsd(value))}
        onMaxMinutesChange={(value) => edit(() => setMaxMinutes(value))}
      />
      {blockedReason === null ? null : (
        <Alert role="status" data-slot="generate-blocked">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{blockedReason}</AlertDescription>
        </Alert>
      )}
      {problem === null ? null : (
        <Alert variant="destructive" data-slot="generate-error" data-problem={problem.kind}>
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{problem.title}</AlertTitle>
          <AlertDescription>
            <p>{problem.message}</p>
            {problem.issues.length === 0 ? null : (
              <ul className="mt-1 list-disc pl-4">
                {problem.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
            {requestId === null ? null : (
              <p className="mt-1 font-mono text-xs">Request ID: {requestId}</p>
            )}
          </AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={blockedReason !== null || budgetBlocked || generation.isPending}
          aria-busy={generation.isPending}
        >
          {generation.isPending ? (
            <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
          ) : (
            <Sparkles aria-hidden="true" data-icon="inline-start" />
          )}
          {generation.isPending ? "Starting" : problem === null ? "Generate" : "Try again"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function GenerateDialog({ open, onOpenChange, ...form }: GenerateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <GenerateForm onOpenChange={onOpenChange} {...form} />
      </DialogContent>
    </Dialog>
  );
}
