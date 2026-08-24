"use client";

import { useQuery } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { SchemaForm, useSchemaForm, type SchemaWidgets } from "@/components/schema-form";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAttemptKeys } from "@/features/bundles/use-attempt-keys";
import { catalogQuery } from "@/features/catalog/queries";
import type { CatalogRole } from "@/features/catalog/types";
import { describeApiError } from "@/lib/api/errors";
import type { JsonObject } from "@/lib/schema/subset";
import { GOAL_KINDS } from "../schemas";
import { useCreateGoal, useUpdateGoal } from "../mutations";
import { simulatorSchemaQuery } from "../queries";
import type { Goal, GoalCreate, GoalKind } from "../types";
import { CriteriaList } from "./criteria-list";
import { BODY_ERROR_SCOPE } from "./persona-form";
import { RoleOptionsContext, RoleWidget } from "./role-widget";

const GOAL_WIDGETS: SchemaWidgets = { criteria: CriteriaList, role: RoleWidget };

const NO_FILTERS = {};

const NO_ROLES: readonly CatalogRole[] = [];

export interface GoalFormProps {
  targetId: string;
  goal?: Goal;
  onDone: () => void;
  onCancel: () => void;
}

interface GoalFields {
  title: string;
  kind: GoalKind;
  statement: string;
  success_criteria: string[];
  role: string | null;
}

function isGoalKind(value: unknown): value is GoalKind {
  return (GOAL_KINDS as readonly unknown[]).includes(value);
}

export function goalFieldsOf(value: JsonObject): GoalFields {
  return {
    title: typeof value.title === "string" ? value.title : "",
    kind: isGoalKind(value.kind) ? value.kind : "complete_flow",
    statement: typeof value.statement === "string" ? value.statement : "",
    success_criteria: Array.isArray(value.success_criteria)
      ? value.success_criteria.filter((entry): entry is string => typeof entry === "string")
      : [],
    role: typeof value.role === "string" && value.role !== "" ? value.role : null,
  };
}

function initialValueOf(goal: Goal | undefined): JsonObject | undefined {
  if (goal === undefined) {
    return undefined;
  }
  return {
    title: goal.title,
    kind: goal.kind,
    statement: goal.statement,
    success_criteria: goal.success_criteria,
    ...(goal.role === null ? {} : { role: goal.role }),
  };
}

function GoalFormBody({
  schema,
  targetId,
  goal,
  onDone,
  onCancel,
}: GoalFormProps & { schema: unknown }) {
  const form = useSchemaForm({
    schema,
    initialValue: initialValueOf(goal),
    errorScope: BODY_ERROR_SCOPE,
  });
  const catalog = useQuery(catalogQuery({ targetId, bundleId: null, filters: NO_FILTERS }));
  const create = useCreateGoal();
  const update = useUpdateGoal();
  const keys = useAttemptKeys();
  const pending = create.isPending || update.isPending;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const value = form.submit();
    if (value === null || pending) {
      return;
    }
    const fields = goalFieldsOf(value);
    if (goal === undefined) {
      const body: GoalCreate = {
        target_id: targetId,
        title: fields.title,
        kind: fields.kind,
        statement: fields.statement,
        success_criteria: fields.success_criteria,
        ...(fields.role === null ? {} : { role: fields.role }),
      };
      create.mutate(
        { body, idempotencyKey: keys.keyFor(JSON.stringify(body)) },
        {
          onSuccess: () => {
            keys.settle();
            onDone();
          },
          onError: (error) => form.applyServerError(error),
        },
      );
      return;
    }
    update.mutate(
      { goalId: goal.id, body: fields },
      { onSuccess: onDone, onError: (error) => form.applyServerError(error) },
    );
  }

  return (
    <RoleOptionsContext value={catalog.data?.roles ?? NO_ROLES}>
      <form
        noValidate
        onSubmit={handleSubmit}
        aria-label={goal === undefined ? "New goal" : `Edit ${goal.title}`}
        className="flex flex-col gap-5"
      >
        <SchemaForm
          schema={schema}
          draft={form.draft}
          onDraftChange={form.setDraft}
          errors={form.errors}
          disabled={pending}
          widgets={GOAL_WIDGETS}
          rawLabel="Goal (JSON)"
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? "Saving" : goal === undefined ? "Create goal" : "Save changes"}
          </Button>
        </div>
      </form>
    </RoleOptionsContext>
  );
}

export function GoalForm(props: GoalFormProps) {
  const schema = useQuery(simulatorSchemaQuery("goal"));

  if (schema.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading the goal form</span>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (schema.isError) {
    return (
      <ErrorState
        title="Could not load the goal form"
        description={describeApiError(schema.error)}
        requestId={readRequestId(schema.error)}
        onRetry={() => void schema.refetch()}
        className="py-8"
      />
    );
  }

  return <GoalFormBody {...props} schema={schema.data} />;
}
