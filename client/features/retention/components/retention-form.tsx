"use client";

import { Archive, TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useReportDirty } from "@/features/settings/unsaved-changes";
import type { RetentionPolicy } from "@/lib/api/types";
import { findReductions, type RetentionReduction } from "../cutoff";
import { describeRetentionFailure, type RetentionFailure } from "../errors";
import { usePutRetention } from "../mutations";
import {
  isFieldChanged,
  isFieldReducing,
  RETENTION_FIELD_INFO,
  RETENTION_FIELDS,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  toFormValues,
  validateRetentionValues,
  type RetentionFormValues,
} from "../schemas";
import { ConfirmReductionDialog } from "./confirm-reduction-dialog";

const DIRTY_SECTION = "retention";
const SAVED_MESSAGE = "Retention policy saved. The next sweep uses it.";

interface PendingSave {
  policy: RetentionPolicy;
  reductions: RetentionReduction[];
}

interface FormBodyProps {
  policy: RetentionPolicy;
  isSaving: boolean;
  failure: RetentionFailure | null;
  showFailure: boolean;
  onEdit: () => void;
  onRequestSave: (next: RetentionPolicy, nowMs: number) => void;
}

function RetentionFormBody({
  policy,
  isSaving,
  failure,
  showFailure,
  onEdit,
  onRequestSave,
}: FormBodyProps) {
  const baseId = useId();
  const [typed, setTyped] = useState<RetentionFormValues>(() => toFormValues(policy));
  const [attempted, setAttempted] = useState(false);

  const changedFields = RETENTION_FIELDS.filter((field) => isFieldChanged(typed, policy, field));
  const changed = changedFields.length > 0;
  useReportDirty(DIRTY_SECTION, changed);
  const validation = validateRetentionValues(typed);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAttempted(true);
    if (!validation.ok || !changed) {
      return;
    }
    onRequestSave(validation.policy, Date.now());
  }

  function discard(): void {
    setTyped(toFormValues(policy));
    setAttempted(false);
    onEdit();
  }

  return (
    <form
      aria-label="Retention policy"
      noValidate
      autoComplete="off"
      onSubmit={submit}
      className="flex flex-col gap-5"
    >
      {showFailure && failure?.message ? (
        <Alert variant="destructive" data-slot="save-failure">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Could not save the retention policy</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : null}
      <FieldGroup>
        {RETENTION_FIELDS.map((field) => {
          const info = RETENTION_FIELD_INFO[field];
          const inputId = `${baseId}-${field}`;
          const helpId = `${inputId}-help`;
          const limitsId = `${inputId}-limits`;
          const errorId = `${inputId}-error`;
          const clientError = attempted && !validation.ok ? validation.errors[field] : undefined;
          const error = clientError ?? failure?.fieldMessages[field];
          const reducing = isFieldReducing(typed, policy, field);
          return (
            <Field key={field} data-field={field} data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor={inputId}>{info.label}</FieldLabel>
              <FieldDescription id={helpId}>{info.effect}</FieldDescription>
              <div className="flex items-center gap-2">
                <Input
                  id={inputId}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={typed[field]}
                  disabled={isSaving}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={[helpId, limitsId, error ? errorId : null]
                    .filter((entry) => entry !== null)
                    .join(" ")}
                  className="max-w-32"
                  onChange={(event) => {
                    const { value } = event.target;
                    setTyped((current) => ({ ...current, [field]: value }));
                    onEdit();
                  }}
                />
                <span aria-hidden="true" className="text-sm text-muted-foreground">
                  days
                </span>
              </div>
              <p id={limitsId} className="text-xs text-muted-foreground">
                {`Now ${policy[field]} days. Allowed: ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS} days.`}
              </p>
              {reducing ? (
                <p
                  data-slot="reducing-note"
                  className="flex items-center gap-1.5 text-xs font-medium"
                >
                  <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                  Lower than today. Saving shows the cut-off date and asks you to confirm.
                </p>
              ) : null}
              {error ? <FieldError id={errorId}>{error}</FieldError> : null}
            </Field>
          );
        })}
      </FieldGroup>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!changed || isSaving}>
          {isSaving ? "Saving" : "Save retention"}
        </Button>
        <Button type="button" variant="ghost" disabled={!changed || isSaving} onClick={discard}>
          Discard changes
        </Button>
        <p className="text-sm text-muted-foreground">
          {changed
            ? `${changedFields.length} unsaved ${changedFields.length === 1 ? "change" : "changes"}`
            : "No unsaved changes"}
        </p>
      </div>
    </form>
  );
}

export function RetentionForm({ policy }: { policy: RetentionPolicy }) {
  const titleId = useId();
  const put = usePutRetention();
  const [failure, setFailure] = useState<RetentionFailure | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function clearFeedback(): void {
    setFailure(null);
    setSavedMessage(null);
  }

  function commit(next: RetentionPolicy): void {
    clearFeedback();
    put.mutate(next, {
      onSuccess: () => {
        setConfirmOpen(false);
        setSavedMessage(SAVED_MESSAGE);
      },
      onError: (error) => {
        const described = describeRetentionFailure(error);
        setFailure(described);
        if (Object.keys(described.fieldMessages).length > 0) {
          setConfirmOpen(false);
        }
      },
    });
  }

  function requestSave(next: RetentionPolicy, nowMs: number): void {
    const reductions = findReductions(policy, next, nowMs);
    if (reductions.length === 0) {
      commit(next);
      return;
    }
    clearFeedback();
    setPendingSave({ policy: next, reductions });
    setConfirmOpen(true);
  }

  function handleConfirmOpenChange(open: boolean): void {
    setConfirmOpen(open);
    if (!open) {
      setFailure(null);
    }
  }

  return (
    <Card role="region" aria-labelledby={titleId} data-section="retention-policy">
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="flex items-center gap-2">
          <Archive aria-hidden="true" className="size-4" />
          Retention policy
        </CardTitle>
        <CardDescription>
          How long Tessa keeps step payloads, recordings and run events before a scheduled
          sweep deletes them. Deleting is permanent.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div role="status" className={savedMessage ? "text-sm font-medium" : "sr-only"}>
          {savedMessage}
        </div>
        <RetentionFormBody
          key={`${policy.steps_days}|${policy.artifacts_days}|${policy.run_events_days}`}
          policy={policy}
          isSaving={put.isPending && !confirmOpen}
          failure={failure}
          showFailure={!confirmOpen}
          onEdit={clearFeedback}
          onRequestSave={requestSave}
        />
        <ConfirmReductionDialog
          open={confirmOpen}
          onOpenChange={handleConfirmOpenChange}
          reductions={pendingSave?.reductions ?? []}
          pending={put.isPending}
          error={failure?.message ?? null}
          onConfirm={() => {
            if (pendingSave !== null) {
              commit(pendingSave.policy);
            }
          }}
        />
      </CardContent>
    </Card>
  );
}
