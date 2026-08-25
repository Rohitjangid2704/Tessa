import { STAGE_ONE_IDS } from "../../stage1/seed";
import type { StageOneStore } from "../../stage1/store";
import { gracieSeeds, generatedSeeds } from "./catalog";
import type { SeedRecord, SeedState, SeedsSeed } from "./types";

export const DEFAULT_SEED_STATE: SeedState = "matched";

export class SeedsStore {
  private latestState: SeedState = DEFAULT_SEED_STATE;
  private emptied = false;
  private readonly records = new Map<string, SeedRecord[]>();

  constructor() {
    this.reset("default");
  }

  reset(seed: SeedsSeed = "default"): void {
    this.latestState = DEFAULT_SEED_STATE;
    this.emptied = seed === "empty";
    this.records.clear();
  }

  configure(state: SeedState): void {
    this.latestState = state;
    this.emptied = false;
    this.records.delete(STAGE_ONE_IDS.gracie);
  }

  get state(): SeedState {
    return this.latestState;
  }

  seedsOf(stageOne: StageOneStore, targetId: string): SeedRecord[] {
    if (this.emptied) {
      return [];
    }
    const bundle = stageOne.latestValidBundle(targetId);
    if (bundle === undefined) {
      return [];
    }
    const cached = this.records.get(targetId);
    if (cached !== undefined) {
      return cached;
    }
    const built =
      targetId === STAGE_ONE_IDS.gracie
        ? gracieSeeds(this.latestState)
        : generatedSeeds(targetId, bundle);
    if (built.length > 0) {
      this.records.set(targetId, built);
    }
    return built;
  }

  latestOf(stageOne: StageOneStore, targetId: string): SeedRecord | undefined {
    let latest: SeedRecord | undefined;
    for (const record of this.seedsOf(stageOne, targetId)) {
      if (latest === undefined || record.version > latest.version) {
        latest = record;
      }
    }
    return latest;
  }

  findSeed(stageOne: StageOneStore, seedId: string): SeedRecord | undefined {
    for (const target of stageOne.targets) {
      const found = this.seedsOf(stageOne, target.id).find((record) => record.id === seedId);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  totals(stageOne: StageOneStore): { targets: number; versions: number } {
    const counts = stageOne.targets.map((target) => this.seedsOf(stageOne, target.id).length);
    return {
      targets: counts.filter((count) => count > 0).length,
      versions: counts.reduce((sum, count) => sum + count, 0),
    };
  }
}
