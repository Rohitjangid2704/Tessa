import { ADMIN_USER } from "../factories/users";
import { notFound } from "../factories/errors";
import { GRACIE_SEEDED_VALUES, SEEDED_VARIABLE_SET_AT } from "../fixtures/gracie-env";
import { ingestBundle } from "../stage1/ingest";
import { STAGE_ONE_IDS, STAGE_ONE_ORIGIN } from "../stage1/seed";
import type { MockState } from "../state";
import { seedProductionHistory, seedTargetLibrary } from "./seed";

const SHOP_URL = "https://shop.qa.example.test";
const READY_NOTE = "Prepared for production runs";
const READY_AT = "2026-10-01T08:00:00.000Z";

export interface ProductionTargetState {
  target_id: string;
  bundle_id: string;
  tier: "production";
  allow_production: boolean;
}

export function readyProductionTarget(
  state: MockState,
  allowProduction: boolean,
): ProductionTargetState {
  const { stageOne, stageTwo: store } = state;
  const target = stageOne.findTarget(STAGE_ONE_IDS.liveShop);
  if (target === undefined) {
    throw notFound("The production target is not in the Stage 1 seed");
  }
  const record =
    stageOne.latestValidBundle(target.id) ??
    ingestBundle({
      store: stageOne,
      target,
      kind: "valid",
      source: "zip",
      note: READY_NOTE,
      uploadedBy: ADMIN_USER.id,
      origin: STAGE_ONE_ORIGIN,
      now: READY_AT,
    }).record;
  for (const entry of stageOne.environmentOf(target.id)) {
    if (entry.stale || entry.value !== null) {
      continue;
    }
    const seeded = GRACIE_SEEDED_VALUES[entry.name];
    const value = seeded ?? (entry.kind === "url" ? SHOP_URL : null);
    if (value !== null) {
      entry.value = value;
      entry.last_set_at = SEEDED_VARIABLE_SET_AT;
      entry.last_set_by = ADMIN_USER.id;
    }
  }
  target.allowProduction = allowProduction;
  seedTargetLibrary(store, target, record);
  seedProductionHistory(state, store, target, record);
  return {
    target_id: target.id,
    bundle_id: record.bundle.id,
    tier: "production",
    allow_production: target.allowProduction,
  };
}
