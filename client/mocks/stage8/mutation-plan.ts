import type { Mutant, MutationOutcome, MutationOutcomeItem } from "@/lib/api/types";
import { stableId, stableInt, stableUnit } from "../stage2/ids";
import type { StageTwoStore } from "../stage2/store";
import { mutationStore, type RunBehaviour } from "./mutation-store";

const KILL_RATE = 0.75;
const MAX_CATCHERS_PER_OUTCOME = 3;

function outcomeFor(mutant: Mutant, invariantId: string, behaviour: RunBehaviour): MutationOutcome {
  if (behaviour === "all_killed") {
    return "killed";
  }
  if (behaviour === "all_survived") {
    return "survived";
  }
  const seeded = mutationStore.seededOutcomesOf(mutant.id)?.[invariantId];
  if (seeded !== undefined) {
    return seeded;
  }
  return stableUnit("mutation_outcome", mutant.name, invariantId) < KILL_RATE
    ? "killed"
    : "survived";
}

function candidateScenarioIds(store: StageTwoStore, targetId: string): string[] {
  return store.scenarios
    .filter(
      (entry) =>
        entry.scenario.target_id === targetId &&
        entry.scenario.status === "accepted" &&
        !entry.scenario.synthetic,
    )
    .map((entry) => entry.scenario.id)
    .sort();
}

function catchersOf(
  store: StageTwoStore,
  mutant: Mutant,
  invariantId: string,
): string[] {
  const pool = candidateScenarioIds(store, mutant.target_id);
  const wanted = 1 + stableInt(0, MAX_CATCHERS_PER_OUTCOME - 1, "mutation_catchers", mutant.name, invariantId);
  if (pool.length === 0) {
    return Array.from({ length: wanted }, (_, index) =>
      stableId("scenario_mutation_catch", mutant.name, invariantId, index),
    );
  }
  const picked = new Set<string>();
  for (let attempt = 0; picked.size < Math.min(wanted, pool.length) && attempt < pool.length * 4; attempt += 1) {
    const chosen = pool[stableInt(0, pool.length - 1, "mutation_catch", mutant.name, invariantId, attempt)];
    if (chosen !== undefined) {
      picked.add(chosen);
    }
  }
  return [...picked];
}

export function planOutcomes(
  store: StageTwoStore,
  mutant: Mutant,
  behaviour: RunBehaviour,
): MutationOutcomeItem[] {
  return mutant.expected_catchers.map((invariantId) => {
    const outcome = outcomeFor(mutant, invariantId, behaviour);
    return {
      invariant_id: invariantId,
      outcome,
      caught_by: outcome === "killed" ? catchersOf(store, mutant, invariantId) : [],
    };
  });
}

export function overallOutcomeOf(outcomes: readonly MutationOutcomeItem[]): MutationOutcome | null {
  if (outcomes.length === 0) {
    return null;
  }
  for (const candidate of ["killed", "survived", "errored"] as const) {
    if (outcomes.some((item) => item.outcome === candidate)) {
      return candidate;
    }
  }
  return "skipped";
}
