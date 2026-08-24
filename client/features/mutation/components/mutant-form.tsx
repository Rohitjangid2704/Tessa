"use client";

import { useQuery } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { toast } from "sonner";
import { SchemaForm, useSchemaForm, type SchemaWidgets } from "@/components/schema-form";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import {
  initialValueOfMutant,
  mutantFieldsOf,
  toMutantCreate,
  toMutantUpdate,
} from "../model";
import { useCreateMutant, useUpdateMutant } from "../mutations";
import { mutantSchemaQuery } from "../queries";
import { INVARIANTS_WIDGET, MUTANT_ERROR_SCOPE } from "../schemas";
import type { Mutant } from "../types";
import { InvariantsWidget } from "./invariants-widget";

const MUTANT_WIDGETS: SchemaWidgets = { [INVARIANTS_WIDGET]: InvariantsWidget };

export interface MutantFormProps {
  targetId: string;
  mutant?: Mutant;
  onDone: () => void;
  onCancel: () => void;
}

function MutantFormBody({
  schema,
  targetId,
  mutant,
  onDone,
  onCancel,
}: MutantFormProps & { schema: unknown }) {
  const form = useSchemaForm({
    schema,
    initialValue: initialValueOfMutant(mutant),
    errorScope: MUTANT_ERROR_SCOPE,
  });
  const create = useCreateMutant();
  const update = useUpdateMutant();
  const pending = create.isPending || update.isPending;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const value = form.submit();
    if (value === null || pending) {
      return;
    }
    const fields = mutantFieldsOf(value);
    if (mutant === undefined) {
      create.create(toMutantCreate(targetId, fields), {
        onSuccess: () => {
          toast.success("Mutant registered");
          onDone();
        },
        onError: (error) => form.applyServerError(error),
      });
      return;
    }
    update.mutate(
      { mutantId: mutant.id, update: toMutantUpdate(fields) },
      {
        onSuccess: () => {
          toast.success("Mutant updated");
          onDone();
        },
        onError: (error) => form.applyServerError(error),
      },
    );
  }

  return (
    <form
      noValidate
      autoComplete="off"
      onSubmit={handleSubmit}
      aria-label={mutant === undefined ? "Register a mutant" : `Edit ${mutant.name}`}
      className="flex flex-col gap-5"
    >
      <SchemaForm
        schema={schema}
        draft={form.draft}
        onDraftChange={form.setDraft}
        errors={form.errors}
        disabled={pending}
        widgets={MUTANT_WIDGETS}
        rawLabel="Mutant (JSON)"
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? "Saving" : mutant === undefined ? "Register mutant" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

export function MutantForm(props: MutantFormProps) {
  const schema = useQuery(mutantSchemaQuery());

  if (schema.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading the mutant form</span>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (schema.isError) {
    return (
      <ErrorState
        title="Could not load the mutant form"
        description={describeApiError(schema.error)}
        requestId={readRequestId(schema.error)}
        onRetry={() => void schema.refetch()}
        className="py-8"
      />
    );
  }

  return <MutantFormBody {...props} schema={schema.data} />;
}
