"use client";

import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { SchemaForm, useSchemaForm } from "@/components/schema-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { settingsQuery } from "@/features/settings/queries";
import type { Plan, Schedule, ScheduleCreate } from "@/lib/api/types";
import { changedKeys, draftWithValue, type SchemaDraft } from "@/lib/schema/draft";
import type { FieldErrors } from "@/lib/schema/validate";
import { cronForTierChange, presetCronOfTier, tierRequiresCron } from "../cron";
import { describeScheduleFailure } from "../errors";
import {
  buildScheduleBody,
  emptyScheduleFields,
  fieldsOfSchedule,
  isScheduleTier,
  scalarsOfSchedule,
  type ScheduleFieldErrors,
  type ScheduleFormFields,
} from "../form-model";
import { SCALAR_SCHEDULE_FIELDS, type ScheduleFormSchemas } from "../schedule-schema";
import { browserTimeZone } from "../time";
import { CronField } from "./cron-field";
import { RunNowSnippet } from "./run-now-snippet";
import { BudgetFields, NotifyFields, PlanField } from "./schedule-form-parts";

export interface ScheduleFormProps {
  formId: string;
  schedule: Schedule | null;
  plans: readonly Plan[];
  planName: string | null;
  schemas: ScheduleFormSchemas;
  isSaving: boolean;
  onSubmit: (body: ScheduleCreate, onFailure: (error: unknown) => void) => void;
}

interface FormFailure {
  message: string;
  requestId: string | null;
}

const SCALAR_NAMES: readonly string[] = SCALAR_SCHEDULE_FIELDS;
const KNOWN_FIELDS: readonly string[] = [
  "plan_id",
  "cron",
  "budget.max_usd",
  "budget.max_minutes",
  "notify.email",
  ...SCALAR_NAMES,
];
const ENABLED_TEXT = "true";
const DEFAULT_TIER = "nightly";
const DEFAULT_TIME_ZONE = "UTC";

function initialFields(
  schedule: Schedule | null,
  plans: readonly Plan[],
  draft: SchemaDraft,
): ScheduleFormFields {
  if (schedule !== null) {
    return fieldsOfSchedule(schedule);
  }
  const tier = draft.values.tier ?? DEFAULT_TIER;
  return {
    ...emptyScheduleFields(plans[0]?.id ?? ""),
    cron: isScheduleTier(tier) ? presetCronOfTier(tier) : "",
  };
}

function pickScalar(errors: ScheduleFieldErrors): FieldErrors {
  return Object.fromEntries(
    Object.entries(errors).filter(([field]) => SCALAR_NAMES.includes(field)),
  );
}

export function ScheduleForm({
  formId,
  schedule,
  plans,
  planName,
  schemas,
  isSaving,
  onSubmit,
}: ScheduleFormProps) {
  const baseId = useId();
  const scalarForm = useSchemaForm({
    schema: schemas.scalar,
    initialValue: schedule === null ? undefined : scalarsOfSchedule(schedule),
  });
  const [fields, setFields] = useState<ScheduleFormFields>(() =>
    initialFields(schedule, plans, scalarForm.draft),
  );
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<ScheduleFieldErrors>({});
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const settings = useQuery(settingsQuery());

  const draftValues = scalarForm.draft.values;
  const tierText = draftValues.tier ?? schedule?.tier ?? DEFAULT_TIER;
  const timezoneText = draftValues.timezone ?? schedule?.timezone ?? DEFAULT_TIME_ZONE;
  const enabledText = draftValues.enabled;
  const enabled =
    enabledText === undefined ? (schedule?.enabled ?? true) : enabledText === ENABLED_TEXT;
  const tier = isScheduleTier(tierText) ? tierText : null;
  const showsCron = tier === null || tierRequiresCron(tier);
  const built = buildScheduleBody(
    { tier: tierText, timezone: timezoneText, enabled },
    fields,
    schemas.full,
  );
  const clientErrors: ScheduleFieldErrors = attempted ? built.errors : {};
  const errorOf = (field: string): string | undefined => serverErrors[field] ?? clientErrors[field];
  const scalarErrors: FieldErrors = {
    ...scalarForm.errors,
    ...pickScalar(clientErrors),
    ...pickScalar(serverErrors),
  };
  const leftover = Object.entries(serverErrors).filter(([field]) => !KNOWN_FIELDS.includes(field));
  const slackWebhookMissing = settings.data?.secrets.slack_webhook_url?.has_value === false;

  function clearServerError(...changed: readonly string[]): void {
    setServerErrors((current) => {
      const remaining = Object.entries(current).filter(([field]) => !changed.includes(field));
      return remaining.length === Object.keys(current).length
        ? current
        : Object.fromEntries(remaining);
    });
  }

  function changeFields(patch: Partial<ScheduleFormFields>, ...changed: readonly string[]): void {
    setFields((current) => ({ ...current, ...patch }));
    clearServerError(...changed);
  }

  function changeScalars(next: SchemaDraft): void {
    const previousTier = scalarForm.draft.values.tier ?? "";
    const nextTier = next.values.tier ?? "";
    clearServerError(...changedKeys(scalarForm.draft, next));
    scalarForm.setDraft(next);
    if (previousTier !== nextTier && isScheduleTier(nextTier) && isScheduleTier(previousTier)) {
      changeFields({ cron: cronForTierChange(nextTier, previousTier, fields.cron) }, "cron");
    }
  }

  function applyBrowserTimeZone(): void {
    changeScalars(draftWithValue(scalarForm.draft, "timezone", browserTimeZone()));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAttempted(true);
    scalarForm.submit();
    if (built.body === null) {
      return;
    }
    setServerErrors({});
    setFailure(null);
    onSubmit(built.body, (error) => {
      const described = describeScheduleFailure(error);
      setServerErrors(described.fieldErrors);
      setFailure(
        described.message === null
          ? null
          : { message: described.message, requestId: described.requestId },
      );
    });
  }

  return (
    <form
      id={formId}
      aria-label={schedule === null ? "New schedule" : "Edit schedule"}
      noValidate
      autoComplete="off"
      onSubmit={handleSubmit}
      className="flex flex-col gap-5"
    >
      {failure === null && leftover.length === 0 ? null : (
        <Alert variant="destructive" data-slot="schedule-save-failure">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Could not save the schedule</AlertTitle>
          <AlertDescription>
            {failure === null ? null : <p>{failure.message}</p>}
            {leftover.map(([field, message]) => (
              <p key={field}>
                {field}: {message}
              </p>
            ))}
            {failure?.requestId ? (
              <p className="font-mono text-xs">Request ID: {failure.requestId}</p>
            ) : null}
          </AlertDescription>
        </Alert>
      )}
      <FieldGroup>
        <PlanField
          id={`${baseId}-plan`}
          plans={plans}
          value={fields.planId}
          onChange={(planId) => changeFields({ planId }, "plan_id")}
          fixedPlanName={schedule === null ? null : (planName ?? "Plan not found")}
          error={errorOf("plan_id")}
          disabled={isSaving}
        />
        <div className="flex flex-col gap-2">
          <SchemaForm
            schema={schemas.scalar}
            draft={scalarForm.draft}
            onDraftChange={changeScalars}
            errors={scalarErrors}
            disabled={isSaving}
          />
          <div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={isSaving}
              onClick={applyBrowserTimeZone}
            >
              Use my time zone ({browserTimeZone()})
            </Button>
          </div>
        </div>
        {showsCron ? (
          <CronField
            id={`${baseId}-cron`}
            value={fields.cron}
            onChange={(cron) => changeFields({ cron }, "cron")}
            timeZone={timezoneText}
            error={errorOf("cron")}
            disabled={isSaving}
          />
        ) : (
          <RunNowSnippet scheduleId={schedule?.id ?? null} />
        )}
        <BudgetFields
          idPrefix={`${baseId}-budget`}
          maxUsd={fields.maxUsd}
          maxMinutes={fields.maxMinutes}
          onMaxUsdChange={(maxUsd) => changeFields({ maxUsd }, "budget.max_usd", "budget")}
          onMaxMinutesChange={(maxMinutes) =>
            changeFields({ maxMinutes }, "budget.max_minutes", "budget")
          }
          usdError={errorOf("budget.max_usd")}
          minutesError={errorOf("budget.max_minutes")}
          disabled={isSaving}
        />
        <NotifyFields
          idPrefix={`${baseId}-notify`}
          slack={fields.slack}
          onSlackChange={(slack) => changeFields({ slack }, "notify.slack")}
          emails={fields.emails}
          onEmailsChange={(emails) => changeFields({ emails }, "notify.email")}
          emailError={errorOf("notify.email")}
          slackWebhookMissing={slackWebhookMissing}
          disabled={isSaving}
        />
      </FieldGroup>
    </form>
  );
}
