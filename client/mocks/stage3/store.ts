import { OracleStore, type OracleSeed } from "./oracle/store";
import { SeedsStore } from "./seeds/store";
import type { SeedsSeed } from "./seeds/types";

export type StageThreeSeed = OracleSeed & SeedsSeed;

export class StageThreeStore {
  readonly oracle = new OracleStore();
  readonly seeds = new SeedsStore();

  reset(seed: StageThreeSeed = "default"): void {
    this.oracle.reset(seed);
    this.seeds.reset(seed);
  }
}
