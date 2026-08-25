import { validationFailed } from "../factories/errors";
import type { MockState } from "../state";
import { AUDIT_VARIANTS, type AuditVariant } from "./audit-data";
import { auditStore } from "./audit-store";
import {
  registerStageElevenSeeder,
  type StageElevenSeed,
  type StageElevenVariants,
} from "./seeding";

const SEEDER_NAME = "audit";

function resolveVariant(seed: StageElevenSeed, variants: StageElevenVariants): AuditVariant {
  const requested = variants[SEEDER_NAME];
  if (requested === undefined) {
    return seed === "empty" ? "empty" : "default";
  }
  const match = AUDIT_VARIANTS.find((variant) => variant === requested);
  if (match === undefined) {
    throw validationFailed([
      {
        loc: ["body", "variants", SEEDER_NAME],
        code: "enum",
        message: `Input should be ${AUDIT_VARIANTS.join(", ")}`,
      },
    ]);
  }
  return match;
}

export function seedAudit(seed: StageElevenSeed, _state: MockState, variants: StageElevenVariants) {
  const variant = resolveVariant(seed, variants);
  auditStore.load(variant);
  return { variant, count: auditStore.count() };
}

registerStageElevenSeeder(SEEDER_NAME, seedAudit);
