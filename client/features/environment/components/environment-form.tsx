"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { TriangleAlert } from "lucide-react";
import { useId } from "react";
import { useForm, useWatch } from "react-hook-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { buildEnvironmentPatch, countPatchChanges, defaultFormValues } from "../build-patch";
import type { SaveFailure } from "../errors";
import { createEnvironmentFormSchema, type EnvironmentFormValues } from "../schemas";
import type { AdapterKind, EnvironmentPatch, EnvironmentVariable } from "../types";
import { EnvVariableField } from "./env-variable-field";

export type EnvironmentReadOnlyReason = "role" | "archived" | null;

export interface EnvironmentFormProps {
  variables: readonly EnvironmentVariable[];
  interfaceKinds?: ReadonlyMap<string, AdapterKind>;
  readOnlyReason: EnvironmentReadOnlyReason;
  isSaving: boolean;
  failure: SaveFailure | null;
  savedMessage: string | null;
  onSave: (patch: EnvironmentPatch) => void;
}

function readOnlyText(reason: Exclude<EnvironmentReadOnlyReason, null>): string {
  return reason === "archived"
    ? "This target is archived, so its environment is read-only."
    : "You have read-only access. Members and admins can change values; you can still see which variables are set.";
}

function describeChanges(count: number): string {
  if (count === 0) {
    return "No unsaved changes";
  }
  return `${count} unsaved ${count === 1 ? "change" : "changes"}`;
}

export function EnvironmentForm({
  variables,
  interfaceKinds,
  readOnlyReason,
  isSaving,
  failure,
  savedMessage,
  onSave,
}: EnvironmentFormProps) {
  const staleHeadingId = useId();
  const form = useForm<EnvironmentFormValues>({
    resolver: zodResolver(createEnvironmentFormSchema(variables)),
    defaultValues: defaultFormValues(variables),
    mode: "onChange",
  });
  const watched = useWatch({ control: form.control });
  const patch = buildEnvironmentPatch(variables, {
    values: watched.values ?? {},
    clear: watched.clear ?? {},
  });
  const changeCount = countPatchChanges(patch);
  const readOnly = readOnlyReason !== null;
  const current = variables.filter((variable) => !variable.stale);
  const stale = variables.filter((variable) => variable.stale);

  const submit = form.handleSubmit((submitted) => {
    const built = buildEnvironmentPatch(variables, submitted);
    if (countPatchChanges(built) > 0) {
      onSave(built);
    }
  });

  function renderField(variable: EnvironmentVariable) {
    return (
      <EnvVariableField
        key={variable.name}
        variable={variable}
        form={form}
        interfaceKinds={interfaceKinds}
        readOnly={readOnly}
        isSaving={isSaving}
        serverError={failure?.fieldMessages[variable.name]}
      />
    );
  }

  return (
    <form
      aria-label="Environment variables"
      noValidate
      autoComplete="off"
      onSubmit={submit}
      className="flex flex-col gap-6"
    >
      {readOnlyReason === null ? null : (
        <p
          data-slot="read-only-notice"
          className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground"
        >
          {readOnlyText(readOnlyReason)}
        </p>
      )}
      <div role="status" className={savedMessage ? "text-sm font-medium" : "sr-only"}>
        {savedMessage}
      </div>
      {failure?.message ? (
        <Alert variant="destructive" data-slot="save-failure">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Could not save the environment</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : null}
      <FieldGroup>{current.map(renderField)}</FieldGroup>
      {stale.length === 0 ? null : (
        <section aria-labelledby={staleHeadingId} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h3 id={staleHeadingId} className="text-base font-semibold">
              Not used by the latest bundle
            </h3>
            <p className="text-sm text-muted-foreground">
              These variables are no longer declared. Their values are kept until you clear them.
            </p>
          </div>
          <FieldGroup>{stale.map(renderField)}</FieldGroup>
        </section>
      )}
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={changeCount === 0 || isSaving}>
            {isSaving ? "Saving" : "Save changes"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={changeCount === 0 || isSaving}
            onClick={() => form.reset(defaultFormValues(variables))}
          >
            Discard changes
          </Button>
          <p className="text-sm text-muted-foreground">{describeChanges(changeCount)}</p>
        </div>
      )}
    </form>
  );
}
