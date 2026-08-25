import type { ApiContext } from "../handlers/api";
import type { OracleStore } from "./oracle/store";
import type { SeedsStore } from "./seeds/store";
import type { StageThreeStore } from "./store";

export function stageThree(context: ApiContext): StageThreeStore {
  return context.state.stageThree;
}

export function oracleStore(context: ApiContext): OracleStore {
  return stageThree(context).oracle;
}

export function seedsStore(context: ApiContext): SeedsStore {
  return stageThree(context).seeds;
}
