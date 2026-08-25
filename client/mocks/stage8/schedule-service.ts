import type { Budget, ScheduleNotify, ScheduleTier } from "@/lib/api/types";
import { validationFailed } from "../factories/errors";
import { BodyReader, type Source } from "../stage1/body";
import { EMAIL_MAX_ITEMS, EMAIL_MAX_LENGTH, EMAIL_PATTERN } from "../stage4/settings-spec";
import type { ErrorDetail } from "../types";
import { isValidTimeZone, validateCron } from "./cron";
import type { NewSchedule } from "./schedules-store";

export const SCHEDULE_TIERS = [
  "commit",
  "nightly",
  "weekly",
] as const satisfies readonly ScheduleTier[];

export const CRON_MAX_LENGTH = 120;
export const TIMEZONE_MAX_LENGTH = 64;

const CREATE_KEYS: readonly string[] = [
  "plan_id",
  "tier",
  "cron",
  "timezone",
  "enabled",
  "budget",
  "notify",
];
const UPDATE_KEYS: readonly string[] = ["tier", "cron", "timezone", "enabled", "budget", "notify"];
const NULL_MEANS_UNCHANGED: readonly string[] = ["tier", "timezone", "enabled", "notify"];

export interface ScheduleChanges {
  tier?: ScheduleTier;
  cron?: string | null;
  timezone?: string;
  enabled?: boolean;
  budget?: Budget | null;
  notify?: ScheduleNotify;
}

function rejectExtraKeys(source: Source, allowed: readonly string[], details: ErrorDetail[]): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) {
      details.push({
        loc: ["body", key],
        code: "extra_forbidden",
        message: "Extra inputs are not permitted",
      });
    }
  }
}

function hasIssueAt(details: readonly ErrorDetail[], field: string): boolean {
  return details.some((detail) => detail.loc[1] === field);
}

function readPositiveNumber(
  source: Source,
  field: string,
  integer: boolean,
  reader: BodyReader,
): number | undefined {
  const raw = source[field];
  if (raw === undefined) {
    reader.issue(field, "missing", "Field required");
    return undefined;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    reader.issue(
      field,
      integer ? "int_type" : "float_type",
      integer ? "Input should be a valid integer" : "Input should be a valid number",
    );
    return undefined;
  }
  if (integer && !Number.isInteger(raw)) {
    reader.issue(
      field,
      "int_from_float",
      "Input should be a valid integer, got a number with a fractional part",
    );
    return undefined;
  }
  if (raw <= 0) {
    reader.issue(field, "greater_than", "Input should be greater than 0");
    return undefined;
  }
  return raw;
}

function readBudget(source: Source, details: ErrorDetail[]): Budget | null | undefined {
  const holder = new BodyReader(source);
  const raw = holder.object("budget", { nullable: true });
  details.push(...holder.details);
  if (raw === undefined || raw === null) {
    return raw;
  }
  const reader = new BodyReader(raw, ["body", "budget"]);
  const maxUsd = readPositiveNumber(raw, "max_usd", false, reader);
  const maxMinutes = readPositiveNumber(raw, "max_minutes", true, reader);
  for (const key of Object.keys(raw)) {
    if (key !== "max_usd" && key !== "max_minutes") {
      reader.issue(key, "extra_forbidden", "Extra inputs are not permitted");
    }
  }
  details.push(...reader.details);
  return maxUsd === undefined || maxMinutes === undefined
    ? undefined
    : { max_usd: maxUsd, max_minutes: maxMinutes };
}

function readNotify(
  source: Source,
  required: boolean,
  details: ErrorDetail[],
): ScheduleNotify | undefined {
  const holder = new BodyReader(source);
  const raw = holder.object("notify", { nullable: false });
  details.push(...holder.details);
  if (raw === undefined || raw === null) {
    if (raw === undefined && required) {
      details.push({ loc: ["body", "notify"], code: "missing", message: "Field required" });
    }
    return undefined;
  }
  const reader = new BodyReader(raw, ["body", "notify"]);
  const slack = reader.boolean("slack", {});
  const email = reader.stringList("email", { maxItems: EMAIL_MAX_ITEMS });
  for (const key of Object.keys(raw)) {
    if (key !== "slack" && key !== "email") {
      reader.issue(key, "extra_forbidden", "Extra inputs are not permitted");
    }
  }
  details.push(...reader.details);
  (email ?? []).forEach((address, index) => {
    if (address.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(address)) {
      details.push({
        loc: ["body", "notify", "email", index],
        code: "value_error",
        message: "Enter a valid email address",
      });
    }
  });
  return { slack: slack ?? false, email: email ?? [] };
}

function readTimezone(
  source: Source,
  required: boolean,
  details: ErrorDetail[],
): string | undefined {
  const reader = new BodyReader(source);
  const value = reader.string("timezone", {
    required,
    min: 1,
    max: TIMEZONE_MAX_LENGTH,
    strip: true,
  });
  details.push(...reader.details);
  if (typeof value !== "string") {
    return undefined;
  }
  if (!isValidTimeZone(value)) {
    details.push({
      loc: ["body", "timezone"],
      code: "invalid_timezone",
      message: `Unknown IANA time zone '${value}'`,
    });
    return undefined;
  }
  return value;
}

function readCron(source: Source, details: ErrorDetail[]): string | null | undefined {
  const reader = new BodyReader(source);
  const value = reader.string("cron", {
    required: false,
    nullable: true,
    min: 1,
    max: CRON_MAX_LENGTH,
    strip: true,
  });
  details.push(...reader.details);
  return value;
}

export function checkTierAndCron(
  tier: ScheduleTier,
  cron: string | null,
  details: ErrorDetail[],
): void {
  if (tier === "commit") {
    if (cron !== null) {
      details.push({
        loc: ["body", "cron"],
        code: "value_error",
        message: "The commit tier runs from CI through run-now and takes no cron",
      });
    }
    return;
  }
  if (cron === null) {
    details.push({
      loc: ["body", "cron"],
      code: "missing",
      message: `A ${tier} schedule needs a cron expression`,
    });
    return;
  }
  const problem = validateCron(cron);
  if (problem !== null) {
    details.push({ loc: ["body", "cron"], code: "invalid_cron", message: problem });
  }
}

export function parseScheduleCreate(source: Source): NewSchedule {
  const details: ErrorDetail[] = [];
  rejectExtraKeys(source, CREATE_KEYS, details);
  const reader = new BodyReader(source);
  const planId = reader.uuid("plan_id", { required: true });
  const tier = reader.enum("tier", SCHEDULE_TIERS, { required: true });
  const enabled = reader.boolean("enabled", {});
  if (enabled === undefined) {
    reader.issue("enabled", "missing", "Field required");
  }
  details.push(...reader.details);
  const cron = readCron(source, details);
  const timezone = readTimezone(source, true, details);
  const budget = readBudget(source, details);
  const notify = readNotify(source, true, details);
  if (typeof tier === "string" && !hasIssueAt(details, "cron")) {
    checkTierAndCron(tier, cron ?? null, details);
  }
  if (
    details.length > 0 ||
    typeof planId !== "string" ||
    typeof tier !== "string" ||
    typeof enabled !== "boolean" ||
    timezone === undefined ||
    notify === undefined
  ) {
    throw validationFailed(details);
  }
  return {
    plan_id: planId,
    tier,
    cron: cron ?? null,
    timezone,
    enabled,
    budget: budget ?? null,
    notify,
  };
}

function dropUnchangedNulls(source: Source): Source {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => value !== null || !NULL_MEANS_UNCHANGED.includes(key),
    ),
  );
}

export function parseScheduleUpdate(raw: Source): ScheduleChanges {
  const source = dropUnchangedNulls(raw);
  const details: ErrorDetail[] = [];
  rejectExtraKeys(source, UPDATE_KEYS, details);
  const reader = new BodyReader(source);
  const tier = reader.enum("tier", SCHEDULE_TIERS, { required: false });
  const enabled = reader.boolean("enabled", {});
  details.push(...reader.details);
  const cron = readCron(source, details);
  const timezone = readTimezone(source, false, details);
  const budget = readBudget(source, details);
  const notify = readNotify(source, false, details);
  if (details.length > 0) {
    throw validationFailed(details);
  }
  const changes: ScheduleChanges = {};
  if (typeof tier === "string") {
    changes.tier = tier;
  }
  if (cron !== undefined) {
    changes.cron = cron;
  }
  if (timezone !== undefined) {
    changes.timezone = timezone;
  }
  if (typeof enabled === "boolean") {
    changes.enabled = enabled;
  }
  if (budget !== undefined) {
    changes.budget = budget;
  }
  if (notify !== undefined) {
    changes.notify = notify;
  }
  return changes;
}
