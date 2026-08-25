import type { MockState } from "../state";
import { bundleSources } from "./bundle-source-store";
import { libraryStore } from "./library-store";
import { registerStageNineSeeder, type StageNineSeed } from "./seeding";

export function seedLibrary(seed: StageNineSeed, state: MockState) {
  libraryStore.mode = seed;
  bundleSources.setMode(seed === "default" ? "default" : "unset");
  if (seed === "default") {
    libraryStore.ensureSeeded(state.stageOne);
  }
  return {
    bundles: seed === "default" ? state.stageOne.bundles.length : 0,
    configured_source_target_ids: bundleSources.configuredTargetIds,
  };
}

registerStageNineSeeder("library", seedLibrary);
