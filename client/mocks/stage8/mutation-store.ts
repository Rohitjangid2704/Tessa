import type {
  Mutant,
  MutationInvariantPower,
  MutationOutcome,
  MutationOutcomeItem,
  MutationRun,
  MutationSummary,
  MutationSurvivor,
  RunStatus,
} from "@/lib/api/types";
import { mockState } from "../state";
import type { MutationScenario } from "./mutation-fixture";

export const RUN_BEHAVIOURS = ["default", "failed", "all_killed", "all_survived"] as const;

export type RunBehaviour = (typeof RUN_BEHAVIOURS)[number];

export type SeededOutcomes = Readonly<Record<string, MutationOutcome>>;

export interface StoredMutationRun {
  id: string;
  runId: string;
  mutantId: string;
  planId: string;
  outcomes: MutationOutcomeItem[];
  power: number | null;
  startedAt: string;
  finishedAt: string | null;
}

const FALLBACK_STATUS: RunStatus = "completed";

function newestFirst(left: StoredMutationRun, right: StoredMutationRun): number {
  return Date.parse(right.startedAt) - Date.parse(left.startedAt);
}

function bySurvivorsThenTotal(left: MutationInvariantPower, right: MutationInvariantPower): number {
  return (
    right.survived - left.survived ||
    right.killed + right.survived - (left.killed + left.survived) ||
    left.invariant_id.localeCompare(right.invariant_id)
  );
}

export class MutationStore {
  private readonly mutantRows = new Map<string, Mutant>();
  private readonly outcomePlans = new Map<string, SeededOutcomes>();
  private readonly runRows: StoredMutationRun[] = [];
  private seeded: MutationScenario | null = null;
  nextRun: RunBehaviour = "default";
  scenarioSource: () => MutationScenario = () => "survivor";
  resetBound = false;

  get seededScenario(): MutationScenario | null {
    return this.seeded;
  }

  markSeeded(scenario: MutationScenario | null): void {
    this.seeded = scenario;
  }

  reset(): void {
    this.mutantRows.clear();
    this.outcomePlans.clear();
    this.runRows.length = 0;
    this.seeded = null;
    this.nextRun = "default";
  }

  clearData(): void {
    this.mutantRows.clear();
    this.outcomePlans.clear();
    this.runRows.length = 0;
  }

  get mutants(): Mutant[] {
    return [...this.mutantRows.values()];
  }

  get runs(): StoredMutationRun[] {
    return this.runRows;
  }

  findMutant(id: string): Mutant | undefined {
    return this.mutantRows.get(id);
  }

  mutantsOf(targetId: string): Mutant[] {
    return this.mutants.filter((mutant) => mutant.target_id === targetId);
  }

  addMutant(mutant: Mutant, plan?: SeededOutcomes): Mutant {
    this.mutantRows.set(mutant.id, mutant);
    if (plan !== undefined) {
      this.outcomePlans.set(mutant.id, plan);
    }
    return mutant;
  }

  seededOutcomesOf(mutantId: string): SeededOutcomes | undefined {
    return this.outcomePlans.get(mutantId);
  }

  removeMutant(id: string): boolean {
    this.outcomePlans.delete(id);
    for (let index = this.runRows.length - 1; index >= 0; index -= 1) {
      if (this.runRows[index]?.mutantId === id) {
        this.runRows.splice(index, 1);
      }
    }
    return this.mutantRows.delete(id);
  }

  addRun(run: StoredMutationRun): StoredMutationRun {
    this.runRows.push(run);
    return run;
  }

  findRun(id: string): StoredMutationRun | undefined {
    return this.runRows.find((run) => run.id === id);
  }

  findRunByRunId(runId: string): StoredMutationRun | undefined {
    return this.runRows.find((run) => run.runId === runId);
  }

  runsOfMutant(mutantId: string): StoredMutationRun[] {
    return this.runRows.filter((run) => run.mutantId === mutantId).sort(newestFirst);
  }

  statusOf(run: StoredMutationRun): RunStatus {
    return mockState.stageTwo.findRun(run.runId)?.run.status ?? FALLBACK_STATUS;
  }

  isActive(run: StoredMutationRun): boolean {
    const entry = mockState.stageTwo.findRun(run.runId);
    return entry !== undefined && !entry.record.finished;
  }

  toWire(run: StoredMutationRun): MutationRun {
    const entry = mockState.stageTwo.findRun(run.runId);
    return {
      id: run.id,
      run_id: run.runId,
      mutant_id: run.mutantId,
      plan_id: run.planId,
      status: entry?.run.status ?? FALLBACK_STATUS,
      outcomes: run.outcomes.map((item) => ({ ...item, caught_by: [...item.caught_by] })),
      power: run.power,
      started_at: entry?.run.started_at ?? entry?.run.created_at ?? run.startedAt,
      finished_at: entry?.run.finished_at ?? run.finishedAt,
    };
  }

  summaryFor(targetId: string): MutationSummary {
    const measured = this.mutantsOf(targetId).filter(
      (mutant) => mutant.status !== "retired" && mutant.last_outcome !== null,
    );
    const killed = measured.filter((mutant) => mutant.last_outcome === "killed").length;
    const survivors = measured
      .filter((mutant) => mutant.last_outcome === "survived")
      .map(
        (mutant): MutationSurvivor => ({
          mutant_id: mutant.id,
          name: mutant.name,
          invariant_ids: [...mutant.expected_catchers],
        }),
      );
    const counts = new Map<string, MutationInvariantPower>();
    for (const mutant of measured) {
      const latest = this.runsOfMutant(mutant.id).find(
        (run) => this.statusOf(run) === "completed",
      );
      for (const item of latest?.outcomes ?? []) {
        if (item.outcome !== "killed" && item.outcome !== "survived") {
          continue;
        }
        const current = counts.get(item.invariant_id) ?? {
          invariant_id: item.invariant_id,
          killed: 0,
          survived: 0,
        };
        counts.set(item.invariant_id, {
          ...current,
          killed: current.killed + (item.outcome === "killed" ? 1 : 0),
          survived: current.survived + (item.outcome === "survived" ? 1 : 0),
        });
      }
    }
    return {
      suite_power: measured.length === 0 ? 0 : killed / measured.length,
      killed,
      total: measured.length,
      survivors,
      per_invariant: [...counts.values()].sort(bySurvivorsThenTotal),
    };
  }
}

export const mutationStore = new MutationStore();
