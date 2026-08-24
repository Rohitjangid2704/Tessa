import { budgetToInput, resolveBudgetInput } from "@/features/plans/budget-input";
import { describeEmailListProblem, formatEmailList, parseEmailList } from "@/lib/email-list";
import type {
  Budget,
  Schedule,
  ScheduleCreate,
  ScheduleTier,
  ScheduleUpdate,
} from "@/lib/api/types";
import { validateAgainstSchema } from "@/lib/schema/validate";
import { isJsonObject, type JsonObject } from "@/lib/schema/subset";
import { tierRequiresCron, validateCronShape } from "./cron";
import { isValidTimeZone } from "./time";

export const SCHEDULE_TIERS: readonly ScheduleTier[] = ["commit", "nightly", "weekly"];

export const SCHEDULE_TIER_LABELS: Readonly<Record<ScheduleTier, string>> = {
  commit: "Commit (from CI)",
  nightly: "Nightly",
  weekly: "Weekly",
};

export interface ScheduleFormFields {
  planId: string;
  cron: string;
  maxUsd: string;
  maxMinutes: string;
  slack: boolean;
  emails: string;
}

export type ScheduleFieldErrors = Record<string, string>;

export interface BuiltSchedule {
  body: ScheduleCreate | null;
  errors: ScheduleFieldErrors;
}

export const UNKNOWN_TIME_ZONE_MESSAGE =
  "Unknown time zone. Use an IANA name such as Europe/London";

export function isScheduleTier(value: unknown): value is ScheduleTier {
  return SCHEDULE_TIERS.some((tier) => tier === value);
}

export function emptyScheduleFields(planId: string): ScheduleFormFields {
  return { planId, cron: "", maxUsd: "", maxMinutes: "", slack: false, emails: "" };
}

export function fieldsOfSchedule(schedule: Schedule): ScheduleFormFields {
  const budget = budgetToInput(schedule.budget);
  return {
    planId: schedule.plan_id,
    cron: schedule.cron ?? "",
    maxUsd: budget.maxUsd,
    maxMinutes: budget.maxMinutes,
    slack: schedule.notify.slack,
    emails: formatEmailList(schedule.notify.email),
  };
}

export function scalarsOfSchedule(schedule: Schedule): JsonObject {
  return { tier: schedule.tier, timezone: schedule.timezone, enabled: schedule.enabled };
}

function budgetErrors(fields: ScheduleFormFields, errors: ScheduleFieldErrors): Budget | null {
  const resolution = resolveBudgetInput(
    { maxUsd: fields.maxUsd, maxMinutes: fields.maxMinutes },
    null,
  );
  if (resolution.errors.max_usd !== undefined) {
    errors["budget.max_usd"] = resolution.errors.max_usd;
  }
  if (resolution.errors.max_minutes !== undefined) {
    errors["budget.max_minutes"] = resolution.errors.max_minutes;
  }
  return resolution.budget ?? null;
}

export interface ScheduleScalars {
  tier: string;
  timezone: string;
  enabled: boolean;
}

export function buildScheduleBody(
  scalars: ScheduleScalars,
  fields: ScheduleFormFields,
  fullSchema: unknown,
): BuiltSchedule {
  const errors: ScheduleFieldErrors = {};
  if (fields.planId === "") {
    errors.plan_id = "Choose a saved plan";
  }
  const { tier, timezone, enabled } = scalars;
  if (!isScheduleTier(tier)) {
    errors.tier = "Choose a tier";
  } else if (tierRequiresCron(tier)) {
    const problem = validateCronShape(fields.cron);
    if (problem !== null) {
      errors.cron = problem;
    }
  }
  if (timezone.trim() === "") {
    errors.timezone = "Enter a time zone";
  } else if (!isValidTimeZone(timezone)) {
    errors.timezone = UNKNOWN_TIME_ZONE_MESSAGE;
  }
  const budget = budgetErrors(fields, errors);
  const emails = parseEmailList(fields.emails);
  const emailProblem = describeEmailListProblem(emails);
  if (emailProblem !== null) {
    errors["notify.email"] = emailProblem;
  }
  if (!isScheduleTier(tier)) {
    return { body: null, errors };
  }
  const body: ScheduleCreate = {
    plan_id: fields.planId,
    tier,
    cron: tierRequiresCron(tier) ? fields.cron.trim() : null,
    timezone: timezone.trim(),
    enabled,
    budget,
    notify: { slack: fields.slack, email: emails.emails },
  };
  if (isJsonObject(fullSchema)) {
    for (const [field, message] of Object.entries(validateAgainstSchema(fullSchema, body))) {
      errors[field] ??= message;
    }
  }
  return { body: Object.keys(errors).length === 0 ? body : null, errors };
}

export function toScheduleUpdate(body: ScheduleCreate): ScheduleUpdate {
  return {
    tier: body.tier,
    cron: body.cron ?? null,
    timezone: body.timezone,
    enabled: body.enabled,
    budget: body.budget ?? null,
    notify: body.notify,
  };
}

export function hasScheduleChanges(schedule: Schedule, body: ScheduleCreate): boolean {
  return (
    schedule.tier !== body.tier ||
    schedule.cron !== (body.cron ?? null) ||
    schedule.timezone !== body.timezone ||
    schedule.enabled !== body.enabled ||
    JSON.stringify(schedule.budget) !== JSON.stringify(body.budget ?? null) ||
    schedule.notify.slack !== body.notify.slack ||
    JSON.stringify(schedule.notify.email) !== JSON.stringify(body.notify.email)
  );
}
