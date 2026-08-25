import { validationFailed } from "../factories/errors";
import type { MockState } from "../state";
import {
  registerStageElevenSeeder,
  type StageElevenSeed,
  type StageElevenVariants,
} from "./seeding";
import { TOKEN_LIMIT, TOKEN_MAX_DAYS, TOKEN_VARIANTS, type TokensVariant } from "./tokens-data";
import { tokensStore } from "./tokens-store";

const SEEDER_NAME = "tokens";

function resolveVariant(variants: StageElevenVariants): TokensVariant {
  const requested = variants[SEEDER_NAME];
  if (requested === undefined) {
    return "none";
  }
  const match = TOKEN_VARIANTS.find((variant) => variant === requested);
  if (match === undefined) {
    throw validationFailed([
      {
        loc: ["body", "variants", SEEDER_NAME],
        code: "enum",
        message: `Input should be ${TOKEN_VARIANTS.join(", ")}`,
      },
    ]);
  }
  return match;
}

export function seedTokens(
  _seed: StageElevenSeed,
  _state: MockState,
  variants: StageElevenVariants,
) {
  const variant = resolveVariant(variants);
  tokensStore.load(variant);
  tokensStore.maxDays = TOKEN_MAX_DAYS;
  return { variant, limit: TOKEN_LIMIT, max_days: tokensStore.maxDays };
}

registerStageElevenSeeder(SEEDER_NAME, seedTokens);
