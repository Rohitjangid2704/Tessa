import { validationFailed } from "../factories/errors";
import type { MockState } from "../state";
import { calibrationFits, FIT_BEHAVIOURS, type FitBehaviour } from "./calibration-fit-store";
import { registerStageTenSeeder, type StageTenSeed, type StageTenVariants } from "./seeding";

const SEEDER_NAME = "calibration_fit";

function resolveVariant(_seed: StageTenSeed, variants: StageTenVariants): FitBehaviour {
  const requested = variants[SEEDER_NAME];
  if (requested === undefined) {
    return "adopted";
  }
  const match = FIT_BEHAVIOURS.find((variant) => variant === requested);
  if (match === undefined) {
    throw validationFailed([
      {
        loc: ["body", "variants", SEEDER_NAME],
        code: "enum",
        message: `Input should be ${FIT_BEHAVIOURS.join(", ")}`,
      },
    ]);
  }
  return match;
}

export function seedCalibrationFit(
  seed: StageTenSeed,
  _state: MockState,
  variants: StageTenVariants,
) {
  const variant = resolveVariant(seed, variants);
  calibrationFits.nextBehaviour = variant;
  return { next_fit: variant, fits: calibrationFits.all().length };
}

registerStageTenSeeder(SEEDER_NAME, seedCalibrationFit);
