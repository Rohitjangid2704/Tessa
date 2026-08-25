import { installCatalogRiskResolver, installCoverageCellAnnotator } from "../factories/annotations";
import { validationFailed } from "../factories/errors";
import { STAGE_ONE_IDS } from "../stage1/seed";
import { mockState, type MockState } from "../state";
import { PROPOSAL_VARIANTS, type ProposalsVariant } from "./proposals-data";
import { riskByFeature } from "./proposals-service";
import { proposalsStore } from "./proposals-store";
import {
  registerStageElevenSeeder,
  type StageElevenSeed,
  type StageElevenVariants,
} from "./seeding";

const SEEDER_NAME = "proposals";

function resolveVariant(seed: StageElevenSeed, variants: StageElevenVariants): ProposalsVariant {
  const requested = variants[SEEDER_NAME];
  if (requested === undefined) {
    return seed === "empty" ? "empty" : "default";
  }
  const match = PROPOSAL_VARIANTS.find((variant) => variant === requested);
  if (match === undefined) {
    throw validationFailed([
      {
        loc: ["body", "variants", SEEDER_NAME],
        code: "enum",
        message: `Input should be ${PROPOSAL_VARIANTS.join(", ")}`,
      },
    ]);
  }
  return match;
}

export function seedProposals(
  seed: StageElevenSeed,
  state: MockState,
  variants: StageElevenVariants,
) {
  const variant = resolveVariant(seed, variants);
  proposalsStore.load(variant);
  const items = proposalsStore.current(STAGE_ONE_IDS.gracie, state)?.items.length ?? 0;
  return { variant, items };
}

registerStageElevenSeeder(SEEDER_NAME, seedProposals);

installCoverageCellAnnotator((targetId, cells) => {
  const record = proposalsStore.current(targetId, mockState);
  if (record === undefined) {
    return [...cells];
  }
  return cells.map((cell) => ({
    ...cell,
    proposal_item_ids: record.items
      .filter(
        (item) =>
          item.status !== "declined" &&
          item.feature_ids.includes(cell.feature_id) &&
          (item.interface_id === null || item.interface_id === cell.interface_id),
      )
      .map((item) => item.id),
  }));
});

installCatalogRiskResolver(
  (targetId, featureId) => riskByFeature(mockState, targetId).get(featureId) ?? null,
);
