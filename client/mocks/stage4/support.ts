import type { ApiContext } from "../handlers/api";
import type { StageFourStore } from "./store";

export function stageFour(context: ApiContext): StageFourStore {
  return context.state.stageFour;
}
