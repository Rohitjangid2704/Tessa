import { validationFailed } from "../factories/errors";
import type { MockState } from "../state";
import { registerStageTenSeeder, type StageTenSeed, type StageTenVariants } from "./seeding";
import { RETENTION_VARIANTS, retentionStore, type RetentionVariant } from "./retention-store";

const SEEDER_NAME = "retention";

function resolveVariant(seed: StageTenSeed, variants: StageTenVariants): RetentionVariant {
  const requested = variants[SEEDER_NAME];
  if (requested === undefined) {
    return seed === "empty" ? "never_swept" : "with_sweep";
  }
  const match = RETENTION_VARIANTS.find((variant) => variant === requested);
  if (match === undefined) {
    throw validationFailed([
      {
        loc: ["body", "variants", SEEDER_NAME],
        code: "enum",
        message: `Input should be ${RETENTION_VARIANTS.join(", ")}`,
      },
    ]);
  }
  return match;
}

export function seedRetention(seed: StageTenSeed, _state: MockState, variants: StageTenVariants) {
  const variant = resolveVariant(seed, variants);
  retentionStore.load(variant);
  return { variant, ...retentionStore.read() };
}

registerStageTenSeeder(SEEDER_NAME, seedRetention);
