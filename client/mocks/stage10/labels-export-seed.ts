import { validationFailed } from "../factories/errors";
import type { MockState } from "../state";
import { applyLabelVolumeSeed, LABEL_VOLUME_SEEDS, type LabelVolumeSeed } from "./labels-volume";
import { registerStageTenSeeder, type StageTenSeed, type StageTenVariants } from "./seeding";

const SEEDER_NAME = "labels_export";

function resolveVariant(seed: StageTenSeed, variants: StageTenVariants): LabelVolumeSeed {
  const requested = variants[SEEDER_NAME];
  if (requested === undefined) {
    return seed === "empty" ? "default" : "below_min";
  }
  const match = LABEL_VOLUME_SEEDS.find((variant) => variant === requested);
  if (match === undefined) {
    throw validationFailed([
      {
        loc: ["body", "variants", SEEDER_NAME],
        code: "enum",
        message: `Input should be ${LABEL_VOLUME_SEEDS.join(", ")}`,
      },
    ]);
  }
  return match;
}

export function seedLabelsExport(
  seed: StageTenSeed,
  _state: MockState,
  variants: StageTenVariants,
) {
  const variant = resolveVariant(seed, variants);
  const stats = applyLabelVolumeSeed(variant);
  return {
    variant,
    total_human: stats.total_human,
    agreement_with_machine: stats.agreement_with_machine,
  };
}

registerStageTenSeeder(SEEDER_NAME, seedLabelsExport);
