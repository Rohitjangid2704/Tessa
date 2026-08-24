import { z } from "zod";
import type { RetentionPolicy } from "@/lib/api/types";

export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 3650;

export const RETENTION_FIELDS = ["steps_days", "artifacts_days", "run_events_days"] as const;

export type RetentionField = (typeof RETENTION_FIELDS)[number];

export type RetentionFormValues = Record<RetentionField, string>;

export type RetentionFieldErrors = Partial<Record<RetentionField, string>>;

export interface RetentionFieldInfo {
  label: string;
  subject: string;
  effect: string;
}

export const RETENTION_FIELD_INFO: Record<RetentionField, RetentionFieldInfo> = {
  steps_days: {
    label: "Step payloads",
    subject: "step payloads",
    effect:
      "Older steps lose their request, response and evidence. The step stays in the run and is marked as purged.",
  },
  artifacts_days: {
    label: "Recordings, traces and screenshots",
    subject: "recordings, traces and screenshots",
    effect:
      "Older files are deleted. The step then reads “expired by retention policy” instead of showing media. Files that open findings reference are kept until the finding is closed.",
  },
  run_events_days: {
    label: "Run events",
    subject: "run events",
    effect: "Older event logs are deleted. An old run no longer shows its event log.",
  },
};

export const RETENTION_CONFIRM_PHRASE = "reduce retention";

const DAYS_TEXT = /^\d+$/;

export const retentionDaysSchema = z
  .number({ error: "Enter a whole number of days" })
  .int("Enter a whole number of days")
  .min(RETENTION_MIN_DAYS, `Use at least ${RETENTION_MIN_DAYS} day`)
  .max(RETENTION_MAX_DAYS, `Use at most ${RETENTION_MAX_DAYS} days`);

export const retentionPolicySchema = z.object({
  steps_days: retentionDaysSchema,
  artifacts_days: retentionDaysSchema,
  run_events_days: retentionDaysSchema,
}) satisfies z.ZodType<RetentionPolicy>;

export type RetentionValidation =
  { ok: true; policy: RetentionPolicy } | { ok: false; errors: RetentionFieldErrors };

export function toFormValues(policy: RetentionPolicy): RetentionFormValues {
  return {
    steps_days: String(policy.steps_days),
    artifacts_days: String(policy.artifacts_days),
    run_events_days: String(policy.run_events_days),
  };
}

export function parseDaysText(text: string): number | null {
  const trimmed = text.trim();
  return DAYS_TEXT.test(trimmed) ? Number(trimmed) : null;
}

export function validateRetentionValues(values: RetentionFormValues): RetentionValidation {
  const errors: RetentionFieldErrors = {};
  const numbers: Partial<Record<RetentionField, number>> = {};
  for (const field of RETENTION_FIELDS) {
    const text = values[field].trim();
    if (text === "") {
      errors[field] = "Enter a number of days";
      continue;
    }
    const days = parseDaysText(text);
    if (days === null) {
      errors[field] = "Use digits only, for example 30";
      continue;
    }
    const checked = retentionDaysSchema.safeParse(days);
    if (checked.success) {
      numbers[field] = checked.data;
    } else {
      errors[field] = checked.error.issues[0]?.message ?? "Enter a whole number of days";
    }
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const policy = retentionPolicySchema.safeParse(numbers);
  return policy.success
    ? { ok: true, policy: policy.data }
    : { ok: false, errors: { steps_days: "Enter a whole number of days" } };
}

export function isFieldChanged(
  values: RetentionFormValues,
  policy: RetentionPolicy,
  field: RetentionField,
): boolean {
  return values[field].trim() !== String(policy[field]);
}

export function isFieldReducing(
  values: RetentionFormValues,
  policy: RetentionPolicy,
  field: RetentionField,
): boolean {
  const days = parseDaysText(values[field]);
  return days !== null && days < policy[field];
}
