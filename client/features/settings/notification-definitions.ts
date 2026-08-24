import type { SecretName } from "@/lib/api/types";
import { SECRET_DEFINITIONS, type SecretDefinition, type ServiceDefinition } from "./schemas";

export const NOTIFICATION_SECRET_NAMES = [
  "slack_webhook_url",
  "smtp_password",
] as const satisfies readonly SecretName[];

export const NOTIFICATION_SECRET_DEFINITIONS: readonly SecretDefinition[] =
  SECRET_DEFINITIONS.filter((definition) =>
    NOTIFICATION_SECRET_NAMES.some((name) => name === definition.name),
  );

export const NOTIFICATION_SERVICE_DEFINITIONS: readonly ServiceDefinition[] = [
  {
    service: "slack",
    label: "Slack",
    description: "Checks the stored webhook and reports whether Slack answers.",
  },
  {
    service: "smtp",
    label: "SMTP",
    description: "Checks that the mail server accepts the stored login.",
  },
];

export const SMTP_WORKER_ENV_KEYS = [
  "TESSA_SMTP_HOST",
  "TESSA_SMTP_PORT",
  "TESSA_SMTP_USER",
  "TESSA_SMTP_FROM",
] as const;

export const NOTIFICATION_EMAIL_PLACEHOLDER = "qa-lead@example.com";
