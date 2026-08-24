import { z } from "zod";
import { isApiError } from "@/lib/api/errors";
import type { PersonalToken, PersonalTokenCreate } from "@/lib/api/types";

export const TOKEN_NAME_MAX_LENGTH = 60;
export const TOKEN_EXPIRY_DAYS_MIN = 1;
export const TOKEN_EXPIRY_DAYS_MAX = 365;
export const PERSONAL_TOKEN_LIMIT = 10;
export const TOKEN_LIMIT_CODE = "token_limit";

const SERVER_MAX_DETAIL_CODE = "less_than_equal";
const EXPIRY_FIELD = "expires_in_days";
const TRAILING_NUMBER = /(\d+)\s*$/;

export const tokenCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name for the token")
    .max(TOKEN_NAME_MAX_LENGTH, `Use at most ${TOKEN_NAME_MAX_LENGTH} characters`),
  expires_in_days: z
    .number({ error: "Enter a whole number of days" })
    .int("Enter a whole number of days")
    .min(TOKEN_EXPIRY_DAYS_MIN, `Use at least ${TOKEN_EXPIRY_DAYS_MIN} day`)
    .max(TOKEN_EXPIRY_DAYS_MAX, `Use at most ${TOKEN_EXPIRY_DAYS_MAX} days`)
    .optional(),
});

export type TokenCreateInput = z.infer<typeof tokenCreateSchema>;

export function toPersonalTokenCreate(input: TokenCreateInput): PersonalTokenCreate {
  return input.expires_in_days === undefined
    ? { name: input.name }
    : { name: input.name, expires_in_days: input.expires_in_days };
}

export function readServerMaxDays(error: unknown): number | null {
  if (!isApiError(error) || error.status !== 422) {
    return null;
  }
  const detail = error.details.find(
    (candidate) =>
      candidate.code === SERVER_MAX_DETAIL_CODE && candidate.loc.includes(EXPIRY_FIELD),
  );
  const match = detail === undefined ? null : TRAILING_NUMBER.exec(detail.message);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

export function isTokenLimitError(error: unknown): boolean {
  return isApiError(error) && error.status === 409 && error.code === TOKEN_LIMIT_CODE;
}

export type TokenState = "active" | "expired" | "revoked";

export function tokenStateOf(token: PersonalToken, now: number): TokenState {
  if (token.revoked_at !== null) {
    return "revoked";
  }
  return Date.parse(token.expires_at) <= now ? "expired" : "active";
}

export function countActiveTokens(tokens: readonly PersonalToken[], now: number): number {
  return tokens.filter((token) => tokenStateOf(token, now) === "active").length;
}
