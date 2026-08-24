"use client";

import { Bell, TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type {
  NotificationSettings,
  NotificationSettingsPatch,
  SettingsRead,
} from "@/lib/api/types";
import { describeEmailListProblem, formatEmailList, parseEmailList } from "@/lib/email-list";
import { NOTIFICATION_EMAIL_PLACEHOLDER } from "../notification-definitions";
import { useGroupSave, type GroupSave } from "../use-group-save";
import { useReportDirty } from "../unsaved-changes";

export interface NotificationsFormProps {
  settings: SettingsRead;
  readOnly: boolean;
}

const NOTIFICATION_LEAVES = ["slack_enabled", "email_to"] as const;
const SAVED_MESSAGE = "Notification settings saved.";
const DIRTY_SECTION = "notifications";

function sameAddresses(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((address, index) => address === right[index]);
}

function revisionOf(notifications: NotificationSettings): string {
  return JSON.stringify([notifications.slack_enabled, notifications.email_to]);
}

interface BodyProps {
  notifications: NotificationSettings;
  slackWebhookSet: boolean;
  readOnly: boolean;
  group: GroupSave;
}

function NotificationsFormBody({ notifications, slackWebhookSet, readOnly, group }: BodyProps) {
  const baseId = useId();
  const slackId = `${baseId}-slack`;
  const emailsId = `${baseId}-emails`;
  const emailsHelpId = `${emailsId}-help`;
  const emailsErrorId = `${emailsId}-error`;
  const [slackEnabled, setSlackEnabled] = useState(notifications.slack_enabled);
  const [emailsText, setEmailsText] = useState(() => formatEmailList(notifications.email_to));
  const [attempted, setAttempted] = useState(false);

  const parsed = parseEmailList(emailsText);
  const clientProblem = describeEmailListProblem(parsed);
  const slackChanged = slackEnabled !== notifications.slack_enabled;
  const emailsChanged =
    parsed.invalid.length > 0 || !sameAddresses(parsed.emails, notifications.email_to);
  const changeCount = Number(slackChanged) + Number(emailsChanged);
  useReportDirty(DIRTY_SECTION, changeCount > 0);
  const emailError = (attempted ? clientProblem : null) ?? group.failure?.fieldMessages.email_to;
  const slackError = group.failure?.fieldMessages.slack_enabled;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAttempted(true);
    if (clientProblem !== null || changeCount === 0) {
      return;
    }
    const patch: NotificationSettingsPatch = {};
    if (slackChanged) {
      patch.slack_enabled = slackEnabled;
    }
    if (emailsChanged) {
      patch.email_to = parsed.emails;
    }
    group.submit({ notifications: patch });
  }

  function discard(): void {
    setSlackEnabled(notifications.slack_enabled);
    setEmailsText(formatEmailList(notifications.email_to));
    setAttempted(false);
    group.clearFeedback();
  }

  return (
    <form
      aria-label="Notifications"
      noValidate
      autoComplete="off"
      onSubmit={submit}
      className="flex flex-col gap-5"
    >
      {group.failure?.message ? (
        <Alert variant="destructive" data-slot="save-failure">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Could not save notifications</AlertTitle>
          <AlertDescription>{group.failure.message}</AlertDescription>
        </Alert>
      ) : null}
      <FieldGroup>
        <Field orientation="horizontal" data-leaf="notifications.slack_enabled">
          <Switch
            id={slackId}
            checked={slackEnabled}
            disabled={readOnly || group.isSaving}
            onCheckedChange={(next) => {
              setSlackEnabled(next);
              group.clearFeedback();
            }}
          />
          <FieldLabel htmlFor={slackId} className="font-normal">
            Post run summaries to Slack
          </FieldLabel>
        </Field>
        {slackError === undefined ? null : <FieldError>{slackError}</FieldError>}
        {slackEnabled && !slackWebhookSet ? (
          <p role="note" className="text-sm text-muted-foreground">
            Slack is on, but no webhook is stored yet. Set the Slack webhook URL below or nothing is
            posted.
          </p>
        ) : null}
        <Field data-leaf="notifications.email_to" data-invalid={emailError ? true : undefined}>
          <FieldLabel htmlFor={emailsId}>Email summaries to</FieldLabel>
          <Textarea
            id={emailsId}
            rows={4}
            value={emailsText}
            readOnly={readOnly}
            disabled={group.isSaving}
            spellCheck={false}
            autoComplete="off"
            placeholder={NOTIFICATION_EMAIL_PLACEHOLDER}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={[emailsHelpId, emailError ? emailsErrorId : null]
              .filter((entry) => entry !== null)
              .join(" ")}
            onChange={(event) => {
              setEmailsText(event.target.value);
              group.clearFeedback();
            }}
          />
          <FieldDescription id={emailsHelpId}>
            One address per line, or separated by commas. Schedules choose whether to send these
            mails; this list is the default audience.
          </FieldDescription>
          {emailError ? <FieldError id={emailsErrorId}>{emailError}</FieldError> : null}
        </Field>
      </FieldGroup>
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={changeCount === 0 || group.isSaving}>
            {group.isSaving ? "Saving" : "Save changes"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={changeCount === 0 || group.isSaving}
            onClick={discard}
          >
            Discard changes
          </Button>
          <p className="text-sm text-muted-foreground">
            {changeCount === 0
              ? "No unsaved changes"
              : `${changeCount} unsaved ${changeCount === 1 ? "change" : "changes"}`}
          </p>
        </div>
      )}
    </form>
  );
}

export function NotificationsForm({ settings, readOnly }: NotificationsFormProps) {
  const titleId = useId();
  const group = useGroupSave("notifications", NOTIFICATION_LEAVES, SAVED_MESSAGE);
  const { notifications } = settings;
  const slackWebhookSet = settings.secrets.slack_webhook_url?.has_value === true;

  return (
    <Card role="region" aria-labelledby={titleId} data-section="notifications">
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="flex items-center gap-2">
          <Bell aria-hidden="true" className="size-4" />
          Notifications
        </CardTitle>
        <CardDescription>
          Where Tessa announces finished scheduled runs, regressions and spent budgets. The bell
          in the header always shows them.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div role="status" className={group.savedMessage ? "text-sm font-medium" : "sr-only"}>
          {group.savedMessage}
        </div>
        {notifications === null ? (
          <p data-slot="notifications-unavailable" className="text-sm text-muted-foreground">
            This API version does not offer notification settings yet.
          </p>
        ) : (
          <NotificationsFormBody
            key={revisionOf(notifications)}
            notifications={notifications}
            slackWebhookSet={slackWebhookSet}
            readOnly={readOnly}
            group={group}
          />
        )}
      </CardContent>
    </Card>
  );
}
