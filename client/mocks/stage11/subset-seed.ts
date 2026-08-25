import { validationFailed } from "../factories/errors";
import type { MockState } from "../state";
import {
  registerStageElevenSeeder,
  type StageElevenSeed,
  type StageElevenVariants,
} from "./seeding";
import { SUBSET_VARIANTS, subsetStore, type SubsetVariant } from "./subset-store";

const SEEDER_NAME = "runs";

function resolveVariant(variants: StageElevenVariants): SubsetVariant | undefined {
  const requested = variants[SEEDER_NAME];
  if (requested === undefined) {
    return undefined;
  }
  const match = SUBSET_VARIANTS.find((variant) => variant === requested);
  if (match === undefined) {
    throw validationFailed([
      {
        loc: ["body", "variants", SEEDER_NAME],
        code: "enum",
        message: `Input should be ${SUBSET_VARIANTS.join(", ")}`,
      },
    ]);
  }
  return match;
}

export function seedSubsetRuns(
  _seed: StageElevenSeed,
  _state: MockState,
  variants: StageElevenVariants,
) {
  subsetStore.variant = resolveVariant(variants) ?? "default";
  return { variant: subsetStore.variant };
}

registerStageElevenSeeder(SEEDER_NAME, seedSubsetRuns);
