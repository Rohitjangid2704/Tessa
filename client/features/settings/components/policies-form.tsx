"use client";

import { ShieldAlert, TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { PolicySettings, PolicySettingsPatch, SettingsRead } from "@/lib/api/types";
import { parseInteger, validateLeaf } from "../schemas";
import { useGroupSave, type GroupSave } from "../use-group-save";
import { useReportDirty } from "../unsaved-changes";
import { SourceBadge } from "./leaf-controls";

export interface PoliciesFormProps {
  settings: SettingsRead;
  readOnly: boolean;
}

const POLICY_LEAVES = ["flaky_quarantine_after"] as const;
const SAVED_MESSAGE = "Flakiness policy saved.";
const DEFAULT_MESSAGE = "Flakiness policy reset to the deployment default.";
const OVERRIDE_PATH = "policies.flaky_quarantine_after";
const DIRTY_SECTION = "policies";

interface BodyProps {
  policies: PolicySettings;
  overridden: boolean;
  readOnly: boolean;
  group: GroupSave;
  onUseDefault: () => void;
}

function PoliciesFormBody({ policies, overridden, readOnly, group, onUseDefault }: BodyProps) {
  const baseId = useId();
  const inputId = `${baseId}-quarantine`;
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const stored = String(policies.flaky_quarantine_after);
  const [typed, setTyped] = useState(stored);
  const [attempted, setAttempted] = useState(false);

  const changed = typed.trim() !== stored;
  useReportDirty(DIRTY_SECTION, changed);
  const clientProblem = validateLeaf("positive-integer", typed);
  const error =
    (attempted ? clientProblem : null) ?? group.failure?.fieldMessages.flaky_quarantine_after;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAttempted(true);
    const value = parseInteger(typed);
    if (clientProblem !== null || value === null || !changed) {
      return;
    }
    const patch: PolicySettingsPatch = { flaky_quarantine_after: value };
    group.submit({ policies: patch });
  }

  function discard(): void {
    setTyped(stored);
    setAttempted(false);
    group.clearFeedback();
  }

  return (
    <form
      aria-label="Flakiness policy"
      noValidate
      autoComplete="off"
      onSubmit={submit}
      className="flex flex-col gap-5"
    >
      {group.failure?.message ? (
        <Alert variant="destructive" data-slot="save-failure">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Could not save the flakiness policy</AlertTitle>
          <AlertDescription>{group.failure.message}</AlertDescription>
        </Alert>
      ) : null}
      <FieldGroup>
        <Field data-leaf={OVERRIDE_PATH} data-invalid={error ? true : undefined}>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
            <FieldLabel htmlFor={inputId}>
              Quarantine a scenario after this many flaky runs
            </FieldLabel>
            <SourceBadge source={overridden ? "db" : "env"} />
          </div>
          <FieldDescription id={helpId}>
            A scenario that comes out flaky in this many runs is quarantined: its results stop
            counting as failures and a flaky finding is filed. A whole number of 1 or more.
          </FieldDescription>
          <Input
            id={inputId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={typed}
            readOnly={readOnly}
            disabled={group.isSaving}
            aria-invalid={error ? true : undefined}
            aria-describedby={[helpId, error ? errorId : null]
              .filter((entry) => entry !== null)
              .join(" ")}
            className="max-w-32"
            onChange={(event) => {
              setTyped(event.target.value);
              group.clearFeedback();
            }}
          />
          {error ? <FieldError id={errorId}>{error}</FieldError> : null}
        </Field>
      </FieldGroup>
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!changed || group.isSaving}>
            {group.isSaving ? "Saving" : "Save changes"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!changed || group.isSaving}
            onClick={discard}
          >
            Discard changes
          </Button>
          {overridden ? (
            <Button type="button" variant="ghost" disabled={group.isSaving} onClick={onUseDefault}>
              Use the default
            </Button>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {changed ? "1 unsaved change" : "No unsaved changes"}
          </p>
        </div>
      )}
    </form>
  );
}

export function PoliciesForm({ settings, readOnly }: PoliciesFormProps) {
  const titleId = useId();
  const group = useGroupSave("policies", POLICY_LEAVES, SAVED_MESSAGE);
  const { policies } = settings;
  const overridden = settings.overrides.includes(OVERRIDE_PATH);

  return (
    <Card role="region" aria-labelledby={titleId} data-section="policies">
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="flex items-center gap-2">
          <ShieldAlert aria-hidden="true" className="size-4" />
          Flakiness policy
        </CardTitle>
        <CardDescription>
          How Tessa treats scenarios whose verdict changes between attempts of the same plan.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div role="status" className={group.savedMessage ? "text-sm font-medium" : "sr-only"}>
          {group.savedMessage}
        </div>
        {policies === null ? (
          <p data-slot="policies-unavailable" className="text-sm text-muted-foreground">
            This API version does not offer policy settings yet.
          </p>
        ) : (
          <PoliciesFormBody
            key={`${policies.flaky_quarantine_after}|${overridden ? "db" : "env"}`}
            policies={policies}
            overridden={overridden}
            readOnly={readOnly}
            group={group}
            onUseDefault={() =>
              group.submit({ policies: { flaky_quarantine_after: null } }, DEFAULT_MESSAGE)
            }
          />
        )}
      </CardContent>
    </Card>
  );
}
