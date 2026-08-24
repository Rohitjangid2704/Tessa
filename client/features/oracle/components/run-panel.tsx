"use client";

import { Play } from "lucide-react";
import { useId, type FormEvent } from "react";
import { SchemaForm, useSchemaForm } from "@/components/schema-form";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAttemptKeys } from "@/features/bundles/use-attempt-keys";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { useRunOracle } from "../mutations";
import type { OracleTemplate } from "../types";

export interface RunPanelProps {
  template: OracleTemplate;
  canRun: boolean;
  accessKnown: boolean;
  onResultStarted: (resultId: string) => void;
}

export function runFingerprint(templateId: string, params: Record<string, unknown>): string {
  return JSON.stringify([templateId, params]);
}

export function RunPanel({ template, canRun, accessKnown, onResultStarted }: RunPanelProps) {
  const headingId = useId();
  const reasonId = useId();
  const form = useSchemaForm({ schema: template.params_schema });
  const run = useRunOracle(template.id);
  const keys = useAttemptKeys();
  const readOnlyRole = accessKnown && !canRun;
  const validationFailure = isApiError(run.error) && run.error.status === 422;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const params = form.submit();
    if (params === null || !canRun) {
      return;
    }
    run.mutate(
      { params, idempotencyKey: keys.keyFor(runFingerprint(template.id, params)) },
      {
        onSuccess: (result) => {
          keys.settle();
          onResultStarted(result.id);
        },
        onError: (error) => form.applyServerError(error),
      },
    );
  }

  return (
    <section data-slot="run-panel" aria-labelledby={headingId} className="flex flex-col gap-4">
      <h3 id={headingId} className="text-sm font-semibold">
        Run with parameters
      </h3>
      <form
        noValidate
        onSubmit={handleSubmit}
        aria-label={`Parameters of ${template.name}`}
        className="flex flex-col gap-4"
      >
        <SchemaForm
          schema={template.params_schema}
          draft={form.draft}
          onDraftChange={form.setDraft}
          errors={form.errors}
          disabled={!canRun || run.isPending}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            disabled={!canRun || run.isPending}
            aria-describedby={readOnlyRole ? reasonId : undefined}
          >
            <Play aria-hidden="true" data-icon="inline-start" />
            {run.isPending ? "Starting" : "Run query"}
          </Button>
          {readOnlyRole ? (
            <p id={reasonId} className="text-sm text-muted-foreground">
              Your role is viewer, so you cannot run queries. A member can.
            </p>
          ) : null}
        </div>
      </form>
      {run.isError && !validationFailure ? (
        <Alert variant="destructive">
          <AlertTitle>Could not start the query</AlertTitle>
          <AlertDescription>
            {describeApiError(run.error)}
            {readRequestId(run.error) === null ? null : ` Request ID: ${readRequestId(run.error)}`}
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
