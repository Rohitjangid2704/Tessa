import { z } from "zod";
import { isConfirmationMatch } from "@/components/typed-confirm-dialog";
import { createSearchParamsCodec, textParam } from "@/lib/search-params";

export const SEED_ID_PARAM = "seed_id";
export const RUN_ID_PARAM = "run_id";
export const GUID_LENGTH = 36;

export const seedSelectionCodec = createSearchParamsCodec({
  seed_id: textParam(GUID_LENGTH),
  run_id: textParam(GUID_LENGTH),
});

const idSchema = z.guid();

export function readId(value: string | undefined): string | null {
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function seedResetSchema(targetName: string) {
  return z.object({
    confirm_target_name: z
      .string()
      .refine((typed) => isConfirmationMatch(typed, targetName), {
        message: "Type the exact name of the target.",
      }),
  });
}

export const CONFIRMATION_MISMATCH_CODE = "confirmation_mismatch";
export const PRODUCTION_BLOCKED_CODE = "production_blocked";
