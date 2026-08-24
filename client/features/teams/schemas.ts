import { z } from "zod";

export const TEAM_NAME_MAX_LENGTH = 80;
export const BUDGET_MAX_USD_MONTH = 1_000_000;

const BUDGET_PATTERN = /^\d+(?:\.\d{1,2})?$/;

export const teamNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a team name")
  .max(TEAM_NAME_MAX_LENGTH, `Use at most ${TEAM_NAME_MAX_LENGTH} characters`);

export const teamFormSchema = z.object({ name: teamNameSchema });

export type TeamFormInput = z.infer<typeof teamFormSchema>;

export const budgetFormSchema = z.object({
  max_usd_month: z
    .string()
    .trim()
    .min(1, "Enter a monthly budget in US dollars")
    .regex(BUDGET_PATTERN, "Use a number with at most two decimals, for example 150 or 99.50")
    .refine((value) => Number(value) > 0, "The budget must be more than zero")
    .refine(
      (value) => Number(value) <= BUDGET_MAX_USD_MONTH,
      `The budget must be at most ${BUDGET_MAX_USD_MONTH.toLocaleString("en-US")}`,
    ),
});

export type BudgetFormInput = z.infer<typeof budgetFormSchema>;

export function budgetFromInput(input: BudgetFormInput): number {
  return Number(input.max_usd_month);
}

export function budgetToInput(maxUsdMonth: number | null): string {
  return maxUsdMonth === null ? "" : String(maxUsdMonth);
}
