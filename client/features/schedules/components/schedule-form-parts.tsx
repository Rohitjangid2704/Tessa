"use client";

import Link from "next/link";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { Plan } from "@/lib/api/types";
import { settingsRoutes } from "@/lib/routes";

export const UNTITLED_PLAN = "Untitled plan";

export interface PlanFieldProps {
  id: string;
  plans: readonly Plan[];
  value: string;
  onChange: (planId: string) => void;
  fixedPlanName: string | null;
  error?: string;
  disabled: boolean;
}

export function PlanField({
  id,
  plans,
  value,
  onChange,
  fixedPlanName,
  error,
  disabled,
}: PlanFieldProps) {
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  if (fixedPlanName !== null) {
    return (
      <Field data-slot="schedule-plan">
        <FieldLabel htmlFor={id}>Plan</FieldLabel>
        <Input id={id} value={fixedPlanName} readOnly aria-describedby={descriptionId} />
        <FieldDescription id={descriptionId}>
          The plan of a schedule cannot change. Delete the schedule and create a new one to move it.
        </FieldDescription>
      </Field>
    );
  }
  return (
    <Field data-slot="schedule-plan" data-invalid={error === undefined ? undefined : true}>
      <FieldLabel htmlFor={id}>Plan</FieldLabel>
      <Select value={value} onValueChange={onChange} disabled={disabled || plans.length === 0}>
        <SelectTrigger
          id={id}
          className="w-full"
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={[descriptionId, error === undefined ? null : errorId]
            .filter((entry) => entry !== null)
            .join(" ")}
        >
          <SelectValue placeholder="Choose a saved plan" />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {plans.map((plan) => (
            <SelectItem key={plan.id} value={plan.id}>
              {plan.name ?? UNTITLED_PLAN}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription id={descriptionId}>
        {plans.length === 0
          ? "Every saved plan of this target already has a schedule, or none is saved yet. Save a plan from the Catalog tab first."
          : "A saved plan has one schedule. Plans that already have one are not listed."}
      </FieldDescription>
      {error === undefined ? null : <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  );
}

export interface BudgetFieldsProps {
  idPrefix: string;
  maxUsd: string;
  maxMinutes: string;
  onMaxUsdChange: (value: string) => void;
  onMaxMinutesChange: (value: string) => void;
  usdError?: string;
  minutesError?: string;
  disabled: boolean;
}

export function BudgetFields({
  idPrefix,
  maxUsd,
  maxMinutes,
  onMaxUsdChange,
  onMaxMinutesChange,
  usdError,
  minutesError,
  disabled,
}: BudgetFieldsProps) {
  const usdId = `${idPrefix}-usd`;
  const minutesId = `${idPrefix}-minutes`;
  return (
    <FieldSet data-slot="schedule-budget" disabled={disabled}>
      <FieldLegend variant="label">Budget per run (optional)</FieldLegend>
      <FieldDescription>
        Ceilings for each scheduled run. Leave both empty to use the budget of the plan.
      </FieldDescription>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field data-invalid={usdError === undefined ? undefined : true}>
          <FieldLabel htmlFor={usdId} className="font-normal">
            Max cost (USD)
          </FieldLabel>
          <Input
            id={usdId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={maxUsd}
            aria-invalid={usdError === undefined ? undefined : true}
            aria-describedby={usdError === undefined ? undefined : `${usdId}-error`}
            onChange={(event) => onMaxUsdChange(event.target.value)}
          />
          {usdError === undefined ? null : (
            <FieldError id={`${usdId}-error`}>{usdError}</FieldError>
          )}
        </Field>
        <Field data-invalid={minutesError === undefined ? undefined : true}>
          <FieldLabel htmlFor={minutesId} className="font-normal">
            Max time (minutes)
          </FieldLabel>
          <Input
            id={minutesId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={maxMinutes}
            aria-invalid={minutesError === undefined ? undefined : true}
            aria-describedby={minutesError === undefined ? undefined : `${minutesId}-error`}
            onChange={(event) => onMaxMinutesChange(event.target.value)}
          />
          {minutesError === undefined ? null : (
            <FieldError id={`${minutesId}-error`}>{minutesError}</FieldError>
          )}
        </Field>
      </div>
    </FieldSet>
  );
}

export interface NotifyFieldsProps {
  idPrefix: string;
  slack: boolean;
  onSlackChange: (slack: boolean) => void;
  emails: string;
  onEmailsChange: (emails: string) => void;
  emailError?: string;
  slackWebhookMissing: boolean;
  disabled: boolean;
}

export function NotifyFields({
  idPrefix,
  slack,
  onSlackChange,
  emails,
  onEmailsChange,
  emailError,
  slackWebhookMissing,
  disabled,
}: NotifyFieldsProps) {
  const slackId = `${idPrefix}-slack`;
  const emailsId = `${idPrefix}-emails`;
  const emailsHelpId = `${emailsId}-help`;
  const emailsErrorId = `${emailsId}-error`;
  return (
    <FieldSet data-slot="schedule-notify" disabled={disabled}>
      <FieldLegend variant="label">Notify when a run finishes</FieldLegend>
      <Field orientation="horizontal">
        <Switch id={slackId} checked={slack} onCheckedChange={onSlackChange} />
        <FieldLabel htmlFor={slackId} className="font-normal">
          Post a summary to Slack
        </FieldLabel>
      </Field>
      {slack && slackWebhookMissing ? (
        <p role="note" className="text-sm text-muted-foreground">
          No Slack webhook is set yet, so nothing would be posted.{" "}
          <Link href={settingsRoutes.notifications()} className="underline underline-offset-3">
            Set it in the notification settings
          </Link>
          .
        </p>
      ) : null}
      <Field data-invalid={emailError === undefined ? undefined : true}>
        <FieldLabel htmlFor={emailsId} className="font-normal">
          Email the summary to
        </FieldLabel>
        <Textarea
          id={emailsId}
          rows={3}
          value={emails}
          spellCheck={false}
          autoComplete="off"
          placeholder="qa-lead@example.com"
          aria-invalid={emailError === undefined ? undefined : true}
          aria-describedby={[emailsHelpId, emailError === undefined ? null : emailsErrorId]
            .filter((entry) => entry !== null)
            .join(" ")}
          onChange={(event) => onEmailsChange(event.target.value)}
        />
        <FieldDescription id={emailsHelpId}>
          One address per line, or separated by commas. The mail server (host, port and user) is set
          in the worker environment.
        </FieldDescription>
        {emailError === undefined ? null : <FieldError id={emailsErrorId}>{emailError}</FieldError>}
      </Field>
    </FieldSet>
  );
}
