import { validationFailed } from "../factories/errors";
import type { MockState } from "../state";
import { registerStageTenSeeder, type StageTenSeed, type StageTenVariants } from "./seeding";
import { TEAM_IDS, TEAMS_VARIANTS, type TeamsVariant } from "./teams-data";
import { teamsStore } from "./teams-store";

const SEEDER_NAME = "teams";

function resolveVariant(seed: StageTenSeed, variants: StageTenVariants): TeamsVariant {
  const requested = variants[SEEDER_NAME];
  if (requested === undefined) {
    return seed === "empty" ? "empty" : "default";
  }
  const match = TEAMS_VARIANTS.find((variant) => variant === requested);
  if (match === undefined) {
    throw validationFailed([
      {
        loc: ["body", "variants", SEEDER_NAME],
        code: "enum",
        message: `Input should be ${TEAMS_VARIANTS.join(", ")}`,
      },
    ]);
  }
  return match;
}

export function seedTeams(seed: StageTenSeed, state: MockState, variants: StageTenVariants) {
  const variant = resolveVariant(seed, variants);
  const store = teamsStore(state);
  store.load(variant);
  const over = store.all.filter(
    (team) => team.maxUsdMonth !== null && team.spentMonthUsd >= team.maxUsdMonth,
  );
  return {
    variant,
    team_count: store.all.length,
    team_ids: TEAM_IDS,
    over_budget_team_ids: over.map((team) => team.id),
  };
}

registerStageTenSeeder(SEEDER_NAME, seedTeams);
