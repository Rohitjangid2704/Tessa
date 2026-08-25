import type { MutationSummary } from "@/lib/api/types";
import { mockState } from "../state";
import { ensureMutationSeed } from "./mutation-seed";
import { mutationStore } from "./mutation-store";

export const MUTATION_SCENARIOS = ["survivor", "all_killed", "none"] as const;

export type MutationScenario = (typeof MUTATION_SCENARIOS)[number];

export function buildMutationSummary(targetId: string, scenario: MutationScenario): MutationSummary {
  ensureMutationSeed(mockState, scenario);
  return mutationStore.summaryFor(targetId);
}
