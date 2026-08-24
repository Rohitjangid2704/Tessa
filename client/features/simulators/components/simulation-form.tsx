"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { catalogQuery } from "@/features/catalog/queries";
import { StartFormShell } from "@/features/runs/components/start-form-shell";
import { describeApiError } from "@/lib/api/errors";
import type { SimulatorTab } from "@/lib/routes";
import { useStartSimulation } from "../mutations";
import { goalOptionsQuery, personaOptionsQuery } from "../queries";
import {
  DEFAULT_ATTEMPTS,
  GOAL_KIND_LABELS,
  MAX_ATTEMPTS,
  MIN_ATTEMPTS,
  resolveSimulationDraft,
  type SimulationFormValues,
} from "../schemas";
import type { SimulationCreate } from "../types";

const NO_FILTERS = {};

type FieldProblems = Partial<Record<keyof SimulationFormValues, string>>;

interface DraftEdits {
  personaId: string | null;
  goalId: string | null;
  role: string | null;
  attempts: string | null;
}

const NO_EDITS: DraftEdits = { personaId: null, goalId: null, role: null, attempts: null };

export interface SimulationFormProps {
  targetId: string;
  onCreate: (tab: Extract<SimulatorTab, "personas" | "goals">) => void;
}

function FormSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading personas and goals</span>
      <Skeleton className="h-8 w-full max-w-md" />
      <Skeleton className="h-8 w-full max-w-md" />
      <Skeleton className="h-8 w-full max-w-md" />
    </div>
  );
}

export function SimulationForm({ targetId, onCreate }: SimulationFormProps) {
  const baseId = useId();
  const personas = useQuery(personaOptionsQuery(targetId));
  const goals = useQuery(goalOptionsQuery(targetId));
  const catalog = useQuery(catalogQuery({ targetId, bundleId: null, filters: NO_FILTERS }));
  const start = useStartSimulation();
  const [edits, setEdits] = useState<DraftEdits>(NO_EDITS);

  if (personas.isPending || goals.isPending) {
    return <FormSkeleton />;
  }

  const failure = personas.isError ? personas : goals.isError ? goals : null;
  if (failure !== null) {
    return (
      <ErrorState
        title="Could not load personas and goals"
        description={describeApiError(failure.error)}
        requestId={readRequestId(failure.error)}
        onRetry={() => {
          void personas.refetch();
          void goals.refetch();
        }}
        className="py-8"
      />
    );
  }

  const personaItems = personas.data ?? [];
  const goalItems = goals.data ?? [];

  if (personaItems.length === 0 || goalItems.length === 0) {
    return (
      <div
        data-slot="simulation-prerequisites"
        className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-4"
      >
        <p className="text-sm">
          A simulation pairs a persona with a goal.{" "}
          {personaItems.length === 0 ? "This target has no persona yet. " : null}
          {goalItems.length === 0 ? "This target has no goal yet." : null}
        </p>
        <div className="flex flex-wrap gap-2">
          {personaItems.length === 0 ? (
            <Button type="button" variant="outline" onClick={() => onCreate("personas")}>
              Create a persona
            </Button>
          ) : null}
          {goalItems.length === 0 ? (
            <Button type="button" variant="outline" onClick={() => onCreate("goals")}>
              Create a goal
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const personaId = edits.personaId ?? "";
  const goalId = edits.goalId ?? "";
  const persona = personaItems.find((candidate) => candidate.id === personaId);
  const goal = goalItems.find((candidate) => candidate.id === goalId);
  const role = edits.role ?? goal?.role ?? "";
  const attempts = edits.attempts ?? String(DEFAULT_ATTEMPTS);
  const roles = catalog.data?.roles ?? [];
  const resolution = resolveSimulationDraft({ personaId, goalId, role, attempts });
  const errors: FieldProblems = "errors" in resolution ? resolution.errors : {};
  const firstProblem = Object.values(errors)[0] ?? null;
  const attemptsError = attempts.trim() === "" ? undefined : errors.k;

  function submit(budget: SimulationCreate["budget"]): void {
    if (!("values" in resolution)) {
      return;
    }
    const { values } = resolution;
    start.start({
      target_id: targetId,
      persona_id: values.persona_id,
      goal_id: values.goal_id,
      role: values.role,
      k: values.k,
      budget,
    });
  }

  return (
    <StartFormShell
      targetId={targetId}
      action="simulators.start"
      label="Start a simulation"
      submitLabel="Start simulation"
      pendingLabel="Starting"
      productionPolicy="blocked"
      isPending={start.isPending}
      error={start.error}
      onSubmit={submit}
      canSubmit={"values" in resolution}
      incompleteReason={firstProblem}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${baseId}-persona`}>Persona</FieldLabel>
          <Select
            value={personaId}
            onValueChange={(next) => setEdits((current) => ({ ...current, personaId: next }))}
          >
            <SelectTrigger id={`${baseId}-persona`} className="w-full max-w-md" aria-required="true">
              <SelectValue placeholder="Choose a persona" />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {personaItems.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {persona === undefined ? null : (
            <FieldDescription>{persona.description}</FieldDescription>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor={`${baseId}-goal`}>Goal</FieldLabel>
          <Select
            value={goalId}
            onValueChange={(next) => setEdits((current) => ({ ...current, goalId: next, role: null }))}
          >
            <SelectTrigger id={`${baseId}-goal`} className="w-full max-w-md" aria-required="true">
              <SelectValue placeholder="Choose a goal" />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {goalItems.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {goal === undefined ? null : (
            <FieldDescription>
              {GOAL_KIND_LABELS[goal.kind]}. {goal.statement}
            </FieldDescription>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor={`${baseId}-role`}>Role</FieldLabel>
          {roles.length === 0 ? (
            <Input
              id={`${baseId}-role`}
              value={role}
              placeholder="guest"
              autoComplete="off"
              aria-required="true"
              className="max-w-md"
              onChange={(event) => setEdits((current) => ({ ...current, role: event.target.value }))}
            />
          ) : (
            <Select
              value={role}
              onValueChange={(next) => setEdits((current) => ({ ...current, role: next }))}
            >
              <SelectTrigger id={`${baseId}-role`} className="w-full max-w-md" aria-required="true">
                <SelectValue placeholder="Choose a role" />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {roles.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <FieldDescription>
            The app role the simulated user signs in as. A goal can suggest one.
          </FieldDescription>
        </Field>
        <Field data-invalid={attemptsError === undefined ? undefined : true}>
          <FieldLabel htmlFor={`${baseId}-attempts`}>Attempts (k)</FieldLabel>
          <Input
            id={`${baseId}-attempts`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={attempts}
            aria-required="true"
            aria-invalid={attemptsError === undefined ? undefined : true}
            aria-describedby={`${baseId}-attempts-help`}
            className="max-w-32"
            onChange={(event) => setEdits((current) => ({ ...current, attempts: event.target.value }))}
          />
          <FieldDescription id={`${baseId}-attempts-help`}>
            Each attempt is a full conversation, from {MIN_ATTEMPTS} to {MAX_ATTEMPTS}. The result
            is pass^k: it holds only when every attempt passes.
          </FieldDescription>
          {attemptsError === undefined ? null : (
            <p role="alert" className="text-xs text-destructive">
              {attemptsError}
            </p>
          )}
        </Field>
      </FieldGroup>
    </StartFormShell>
  );
}
