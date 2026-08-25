import { registerRunScript, registerSeedingPhase } from "../../server/run-simulator";
import type { RunScriptFactory, SeedingPhaseBuilder } from "../../simulation/script";
import { mockState } from "../../state";
import { planSeedRun } from "./outcome";
import { buildSeedingPhase, buildSeedRunScript } from "./script";
import type { SeedAction } from "./types";

const FALLBACK_ACTION: SeedAction = "verify";

function actionOf(params: Record<string, unknown>): SeedAction {
  return params.action === "reset" ? "reset" : FALLBACK_ACTION;
}

export const seedRunFactory: RunScriptFactory = ({ params }) => {
  const seedId = typeof params.seed_id === "string" ? params.seed_id : "";
  const record = mockState.stageThree.seeds.findSeed(mockState.stageOne, seedId);
  if (record === undefined) {
    return {
      actions: [
        { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
        { atMs: 300, label: "finish", run: (context) => context.finish("failed", "Seed not found") },
      ],
    };
  }
  const plan = planSeedRun(record, actionOf(params), mockState.faults.seedMismatch);
  return buildSeedRunScript(record, plan);
};

export const seedingPhaseBuilder: SeedingPhaseBuilder = ({ targetId }) => {
  if (targetId === null) {
    return null;
  }
  const target = mockState.stageOne.findTarget(targetId);
  if (target === undefined || target.tier === "production") {
    return null;
  }
  const record = mockState.stageThree.seeds.latestOf(mockState.stageOne, targetId);
  if (record === undefined || !record.hasResetScript) {
    return null;
  }
  return buildSeedingPhase(record, planSeedRun(record, "reset", mockState.faults.seedMismatch));
};

registerRunScript("seed", seedRunFactory);
registerSeedingPhase(seedingPhaseBuilder);
