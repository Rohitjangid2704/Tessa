"use client";

import { useQuery } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { SchemaForm, useSchemaForm } from "@/components/schema-form";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAttemptKeys } from "@/features/bundles/use-attempt-keys";
import { describeApiError } from "@/lib/api/errors";
import { isJsonObject, type JsonObject } from "@/lib/schema/subset";
import { useCreatePersona, useUpdatePersona } from "../mutations";
import { simulatorSchemaQuery } from "../queries";
import type { Persona, PersonaCreate } from "../types";

export const BODY_ERROR_SCOPE = ["body"] as const;

export interface PersonaFormProps {
  targetId: string;
  persona?: Persona;
  onDone: () => void;
  onCancel: () => void;
}

interface PersonaFields {
  name: string;
  description: string;
  traits: Record<string, unknown>;
}

export function personaFieldsOf(value: JsonObject): PersonaFields {
  return {
    name: typeof value.name === "string" ? value.name : "",
    description: typeof value.description === "string" ? value.description : "",
    traits: isJsonObject(value.traits) ? value.traits : {},
  };
}

function initialValueOf(persona: Persona | undefined): JsonObject | undefined {
  return persona === undefined
    ? undefined
    : { name: persona.name, description: persona.description, traits: persona.traits };
}

function PersonaFormBody({
  schema,
  targetId,
  persona,
  onDone,
  onCancel,
}: PersonaFormProps & { schema: unknown }) {
  const form = useSchemaForm({
    schema,
    initialValue: initialValueOf(persona),
    errorScope: BODY_ERROR_SCOPE,
  });
  const create = useCreatePersona();
  const update = useUpdatePersona();
  const keys = useAttemptKeys();
  const pending = create.isPending || update.isPending;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const value = form.submit();
    if (value === null || pending) {
      return;
    }
    const fields = personaFieldsOf(value);
    if (persona === undefined) {
      const body: PersonaCreate = { target_id: targetId, ...fields };
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
      { personaId: persona.id, body: fields },
      { onSuccess: onDone, onError: (error) => form.applyServerError(error) },
    );
  }

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      aria-label={persona === undefined ? "New persona" : `Edit ${persona.name}`}
      className="flex flex-col gap-5"
    >
      <SchemaForm
        schema={schema}
        draft={form.draft}
        onDraftChange={form.setDraft}
        errors={form.errors}
        disabled={pending}
        rawLabel="Persona (JSON)"
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? "Saving" : persona === undefined ? "Create persona" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

export function PersonaForm(props: PersonaFormProps) {
  const schema = useQuery(simulatorSchemaQuery("persona"));

  if (schema.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading the persona form</span>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (schema.isError) {
    return (
      <ErrorState
        title="Could not load the persona form"
        description={describeApiError(schema.error)}
        requestId={readRequestId(schema.error)}
        onRetry={() => void schema.refetch()}
        className="py-8"
      />
    );
  }

  return <PersonaFormBody {...props} schema={schema.data} />;
}
