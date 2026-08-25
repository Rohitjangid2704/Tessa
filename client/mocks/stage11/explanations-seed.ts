import { validationFailed } from "../factories/errors";
import type { MockState } from "../state";
import {
  EXPLANATIONS_VARIANTS,
  explanationsStore,
  type ExplanationsVariant,
} from "./explanations-store";
import {
  registerStageElevenSeeder,
  type StageElevenSeed,
  type StageElevenVariants,
} from "./seeding";

const SEEDER_NAME = "explanations";

function resolveVariant(variants: StageElevenVariants): ExplanationsVariant | undefined {
  const requested = variants[SEEDER_NAME];
  if (requested === undefined) {
    return undefined;
  }
  const match = EXPLANATIONS_VARIANTS.find((variant) => variant === requested);
  if (match === undefined) {
    throw validationFailed([
      {
        loc: ["body", "variants", SEEDER_NAME],
        code: "enum",
        message: `Input should be ${EXPLANATIONS_VARIANTS.join(", ")}`,
      },
    ]);
  }
  return match;
}

export function seedExplanations(
  _seed: StageElevenSeed,
  _state: MockState,
  variants: StageElevenVariants,
) {
  const requested = resolveVariant(variants);
  if (requested === undefined) {
    explanationsStore.reset();
  } else {
    explanationsStore.variant = requested;
  }
  return { variant: explanationsStore.variant };
}

registerStageElevenSeeder(SEEDER_NAME, seedExplanations);
