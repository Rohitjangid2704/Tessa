import { validationFailed } from "../factories/errors";
import type { MockState } from "../state";
import { LIVE_PROBE_SCENARIOS, liveProbes, type LiveProbeScenario } from "./live-probes-store";
import { registerStageTenSeeder, type StageTenSeed, type StageTenVariants } from "./seeding";

const SEEDER_NAME = "live_probes";

function resolveVariant(seed: StageTenSeed, variants: StageTenVariants): LiveProbeScenario {
  const requested = variants[SEEDER_NAME];
  if (requested === undefined) {
    return seed === "empty" ? "none" : "fresh";
  }
  const match = LIVE_PROBE_SCENARIOS.find((variant) => variant === requested);
  if (match === undefined) {
    throw validationFailed([
      {
        loc: ["body", "variants", SEEDER_NAME],
        code: "enum",
        message: `Input should be ${LIVE_PROBE_SCENARIOS.join(", ")}`,
      },
    ]);
  }
  return match;
}

export function seedLiveProbes(seed: StageTenSeed, _state: MockState, variants: StageTenVariants) {
  const variant = resolveVariant(seed, variants);
  liveProbes.setScenario(variant);
  return { variant, live_probes: liveProbes.read() };
}

registerStageTenSeeder(SEEDER_NAME, seedLiveProbes);
