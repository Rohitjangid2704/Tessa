"use client";

import { useId, type FormEvent, type ReactNode } from "react";
import { LoaderCircle, Play, ShieldAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatPlaceholder } from "@/features/plans/budget-input";
import { useTarget } from "@/features/targets/queries";
import type { TargetTier } from "@/features/targets/types";
import type { Budget } from "@/lib/api/types";
import { useCan } from "@/lib/auth/can";
import type { PermissionId } from "@/lib/auth/permissions";
import { targetRoutes } from "@/lib/routes";
import {
  classifyStartError,
  PRODUCTION_ALWAYS_BLOCKED_MESSAGE,
  PRODUCTION_READ_ONLY_REFUSED_MESSAGE,
  type StartProductionPolicy,
  type StartProblem,
} from "../start-errors";
import { useStartBudget } from "../use-start-budget";

export type StartAction = Extract<
  PermissionId,
  "explore.start" | "simulators.start" | "redteam.start"
>;

export type StartFormShellProps = {
  targetId: string;
  action: StartAction;
  label: string;
  submitLabel: string;
  pendingLabel: string;
  productionPolicy: StartProductionPolicy;
  isPending: boolean;
  error: unknown;
  onSubmit: (budget: Budget) => void;
  canSubmit?: boolean;
  incompleteReason?: string | null;
  describeError?: (error: unknown) => ReactNode;
  children: ReactNode;
};

function productionRefusal(
  policy: StartProductionPolicy,
  tier: TargetTier | undefined,
  allowProduction: boolean,
): string | null {
  if (tier !== "production") {
    return null;
  }
  if (policy === "blocked") {
    return PRODUCTION_ALWAYS_BLOCKED_MESSAGE;
  }
  return allowProduction ? null : PRODUCTION_READ_ONLY_REFUSED_MESSAGE;
}

function ProductionNotice({
  targetId,
  targetName,
  policy,
  refusal,
}: {
  targetId: string;
  targetName: string;
  policy: StartProductionPolicy;
  refusal: string | null;
}) {
  return (
    <Alert role="note" data-slot="start-production-notice" data-policy={policy}>
      <ShieldAlert aria-hidden="true" />
      <AlertTitle>{targetName} is a production target</AlertTitle>
      <AlertDescription>
        <p>
          {policy === "blocked"
            ? PRODUCTION_ALWAYS_BLOCKED_MESSAGE
            : "The session runs read-only here: it looks and verifies but never submits or changes data."}
        </p>
        {policy === "read_only" && refusal !== null ? (
          <p>
            An admin has not enabled production runs for this target yet, so starting is refused.{" "}
            <Link href={targetRoutes.detail(targetId)} className="underline underline-offset-3">
              Open the target settings
            </Link>
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function StartErrorAlert({ problem, error }: { problem: StartProblem; error: unknown }) {
  const requestId = readRequestId(error);
  return (
    <Alert variant="destructive" data-slot="start-error" data-problem={problem.kind}>
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
        {requestId === null ? null : <p className="font-mono text-xs">Request ID: {requestId}</p>}
      </AlertDescription>
    </Alert>
  );
}

type BudgetFieldProps = {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  inputMode: "decimal" | "numeric";
  error: string | undefined;
  onChange: (value: string) => void;
};

function BudgetField({
  id,
  label,
  value,
  placeholder,
  inputMode,
  error,
  onChange,
}: BudgetFieldProps) {
  const errorId = `${id}-error`;
  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="text"
        inputMode={inputMode}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        onChange={(event) => onChange(event.target.value)}
      />
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </Field>
  );
}

export function StartFormShell({
  targetId,
  action,
  label,
  submitLabel,
  pendingLabel,
  productionPolicy,
  isPending,
  error,
  onSubmit,
  canSubmit = true,
  incompleteReason = null,
  describeError,
  children,
}: StartFormShellProps) {
  const reasonId = useId();
  const budgetId = useId();
  const canStart = useCan(action);
  const target = useTarget(targetId);
  const budget = useStartBudget();

  const tier = target.data?.tier;
  const refusal = productionRefusal(productionPolicy, tier, target.data?.allow_production ?? false);
  const budgetBlocker = budget.loading
    ? "Loading the default budget"
    : budget.budget === null
      ? "Enter both budget limits"
      : null;
  const blocker = !canStart
    ? "Starting needs the member role"
    : refusal !== null
      ? refusal
      : !canSubmit
        ? incompleteReason
        : budgetBlocker;
  const submitDisabled =
    isPending || !canStart || refusal !== null || !canSubmit || budgetBlocker !== null;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (submitDisabled || budget.budget === null) {
      return;
    }
    onSubmit(budget.budget);
  }

  const hasError = error !== null && error !== undefined;
  const errorView = hasError ? (
    (describeError?.(error) ?? (
      <StartErrorAlert problem={classifyStartError(error, productionPolicy)} error={error} />
    ))
  ) : null;

  return (
    <div data-slot="start-form-shell" className="flex flex-col gap-4">
      {tier === "production" && target.data !== undefined ? (
        <ProductionNotice
          targetId={targetId}
          targetName={target.data.name}
          policy={productionPolicy}
          refusal={refusal}
        />
      ) : null}
      {canStart ? null : (
        <p role="status" data-slot="viewer-note" className="text-sm text-muted-foreground">
          You can read this page. Starting a session needs the member or admin role.
        </p>
      )}
      <form aria-label={label} noValidate onSubmit={handleSubmit} className="flex flex-col gap-6">
        <fieldset
          disabled={!canStart || isPending}
          className="flex min-w-0 flex-col gap-6 border-0 p-0"
        >
          {children}
          <FieldGroup>
            <div className="grid gap-3 sm:grid-cols-2">
              <BudgetField
                id={`${budgetId}-usd`}
                label="Max cost (USD)"
                value={budget.maxUsd}
                placeholder={formatPlaceholder(undefined)}
                inputMode="decimal"
                error={budget.errors.max_usd}
                onChange={budget.setMaxUsd}
              />
              <BudgetField
                id={`${budgetId}-minutes`}
                label="Max time (minutes)"
                value={budget.maxMinutes}
                placeholder={formatPlaceholder(undefined)}
                inputMode="numeric"
                error={budget.errors.max_minutes}
                onChange={budget.setMaxMinutes}
              />
            </div>
            <FieldDescription>
              {budget.defaultsFailed
                ? "The default budget could not be loaded from Settings, so enter both limits."
                : "Prefilled from the budget defaults in Settings. The session stops when either limit is reached."}
            </FieldDescription>
          </FieldGroup>
        </fieldset>
        {errorView}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            disabled={submitDisabled}
            aria-busy={isPending}
            aria-describedby={blocker === null ? undefined : reasonId}
          >
            {isPending ? (
              <LoaderCircle
                aria-hidden="true"
                data-icon="inline-start"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : (
              <Play aria-hidden="true" data-icon="inline-start" />
            )}
            {isPending ? pendingLabel : submitLabel}
          </Button>
          {blocker === null ? null : (
            <p id={reasonId} data-slot="start-blocker" className="text-sm text-muted-foreground">
              {blocker}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
