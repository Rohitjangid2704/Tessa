import { maxMinutesSchema, maxUsdSchema } from "./schemas";
import type { Budget } from "./types";

export interface BudgetInput {
  maxUsd: string;
  maxMinutes: string;
}

export interface BudgetFieldErrors {
  max_usd?: string;
  max_minutes?: string;
}

export interface BudgetResolution {
  budget: Budget | undefined;
  errors: BudgetFieldErrors;
}

const DECIMAL_PATTERN = /^(?:\d+\.?\d*|\.\d+)$/;
const INTEGER_PATTERN = /^\d+$/;

export const MAX_USD_ERROR = "Enter an amount above 0";
export const MAX_MINUTES_ERROR = "Enter a whole number of minutes, 1 or more";
export const BUDGET_PAIR_ERROR = "Enter a value here too, or clear both limits to use the defaults";

type FieldReading = { kind: "empty" } | { kind: "invalid" } | { kind: "valid"; value: number };

function readUsd(text: string): FieldReading {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { kind: "empty" };
  }
  if (!DECIMAL_PATTERN.test(trimmed)) {
    return { kind: "invalid" };
  }
  const parsed = maxUsdSchema.safeParse(Number(trimmed));
  return parsed.success ? { kind: "valid", value: parsed.data } : { kind: "invalid" };
}

function readMinutes(text: string): FieldReading {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { kind: "empty" };
  }
  if (!INTEGER_PATTERN.test(trimmed)) {
    return { kind: "invalid" };
  }
  const parsed = maxMinutesSchema.safeParse(Number(trimmed));
  return parsed.success ? { kind: "valid", value: parsed.data } : { kind: "invalid" };
}

export function resolveBudgetInput(
  input: BudgetInput,
  serverDefault: Budget | null,
): BudgetResolution {
  const usd = readUsd(input.maxUsd);
  const minutes = readMinutes(input.maxMinutes);
  const errors: BudgetFieldErrors = {};
  if (usd.kind === "invalid") {
    errors.max_usd = MAX_USD_ERROR;
  }
  if (minutes.kind === "invalid") {
    errors.max_minutes = MAX_MINUTES_ERROR;
  }
  if (usd.kind === "invalid" || minutes.kind === "invalid") {
    return { budget: undefined, errors };
  }
  if (usd.kind === "empty" && minutes.kind === "empty") {
    return { budget: undefined, errors };
  }
  const maxUsd = usd.kind === "valid" ? usd.value : serverDefault?.max_usd;
  const maxMinutes = minutes.kind === "valid" ? minutes.value : serverDefault?.max_minutes;
  if (maxUsd === undefined) {
    errors.max_usd = BUDGET_PAIR_ERROR;
  }
  if (maxMinutes === undefined) {
    errors.max_minutes = BUDGET_PAIR_ERROR;
  }
  if (maxUsd === undefined || maxMinutes === undefined) {
    return { budget: undefined, errors };
  }
  return { budget: { max_usd: maxUsd, max_minutes: maxMinutes }, errors };
}

export function hasBudgetInput(input: BudgetInput): boolean {
  return input.maxUsd.trim() !== "" || input.maxMinutes.trim() !== "";
}

export function hasBudgetErrors(errors: BudgetFieldErrors): boolean {
  return errors.max_usd !== undefined || errors.max_minutes !== undefined;
}

export function budgetToInput(budget: Budget | null | undefined): BudgetInput {
  return budget === null || budget === undefined
    ? { maxUsd: "", maxMinutes: "" }
    : { maxUsd: String(budget.max_usd), maxMinutes: String(budget.max_minutes) };
}

export function formatPlaceholder(value: number | undefined): string {
  return value === undefined ? "Server default" : String(value);
}
