import { validationFailed } from "../factories/errors";
import type { MockState } from "../state";
import { registerStageTenSeeder, type StageTenSeed, type StageTenVariants } from "./seeding";
import { SEEDED_USER_IDS, STAGE_TEN_TEAM_IDS } from "./users-data";
import { USERS_VARIANTS, usersStore, type UsersVariant } from "./users-store";

const SEEDER_NAME = "users";

function resolveVariant(variants: StageTenVariants): UsersVariant {
  const requested = variants[SEEDER_NAME];
  if (requested === undefined) {
    return "default";
  }
  const match = USERS_VARIANTS.find((variant) => variant === requested);
  if (match === undefined) {
    throw validationFailed([
      {
        loc: ["body", "variants", SEEDER_NAME],
        code: "enum",
        message: `Input should be ${USERS_VARIANTS.join(", ")}`,
      },
    ]);
  }
  return match;
}

export function seedUsers(_seed: StageTenSeed, state: MockState, variants: StageTenVariants) {
  const variant = resolveVariant(variants);
  usersStore.load(variant, state);
  return {
    variant,
    count: state.users.length,
    seeded_ids: SEEDED_USER_IDS,
    team_ids: STAGE_TEN_TEAM_IDS,
  };
}

registerStageTenSeeder(SEEDER_NAME, seedUsers);
