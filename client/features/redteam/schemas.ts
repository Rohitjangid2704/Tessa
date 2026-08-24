import { z } from "zod";
import type { Budget, RedTeamCreate } from "@/lib/api/types";
import { createSearchParamsCodec, uuidParam } from "@/lib/search-params";
import { targetIdParam } from "@/features/targets/target-id-param";

export const MAX_ROUNDS_LIMIT = 50;
export const WHOLE_NUMBER = /^\d+$/;

function isValidMaxRounds(value: string): boolean {
  if (value === "") {
    return true;
  }
  if (!WHOLE_NUMBER.test(value)) {
    return false;
  }
  const rounds = Number(value);
  return rounds >= 1 && rounds <= MAX_ROUNDS_LIMIT;
}

export const redTeamFormSchema = z.object({
  role: z.string().trim().min(1, "Choose the role the attacker plays against"),
  families: z.array(z.string().min(1)).min(1, "Choose at least one attack family"),
  max_rounds: z
    .string()
    .trim()
    .refine(isValidMaxRounds, `Enter a whole number from 1 to ${MAX_ROUNDS_LIMIT}, or leave it empty`),
});

export type RedTeamFormValues = z.infer<typeof redTeamFormSchema>;

export const EMPTY_RED_TEAM_FORM: RedTeamFormValues = { role: "", families: [], max_rounds: "" };

export type RedTeamFormErrors = Partial<Record<keyof RedTeamFormValues, string>>;

export function validateRedTeamForm(values: RedTeamFormValues): RedTeamFormErrors {
  const parsed = redTeamFormSchema.safeParse(values);
  if (parsed.success) {
    return {};
  }
  const errors: RedTeamFormErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === "role" || field === "families" || field === "max_rounds") {
      errors[field] ??= issue.message;
    }
  }
  return errors;
}

export function toRedTeamCreate(
  values: RedTeamFormValues,
  targetId: string,
  budget: Budget,
): RedTeamCreate {
  const maxRounds = values.max_rounds.trim();
  return {
    target_id: targetId,
    role: values.role.trim(),
    families: values.families,
    max_rounds: maxRounds === "" ? null : Number(maxRounds),
    budget,
  };
}

export const redteamPageCodec = createSearchParamsCodec({
  target_id: targetIdParam(),
  run_id: uuidParam(),
});
