import { SimulationClock } from "../simulation/clock";
import type { MockState, RunRecord } from "../state";
import type { BrowserSession, Plan, Run, RunScenario, Step, StepSummary } from "@/lib/api/types";
import type { StageTwoSeed } from "./seed";
import type { ArtifactDef, ScenarioRecord, StepRecord } from "./types";

type StageTwoSeeder = (state: MockState, store: StageTwoStore, seed: StageTwoSeed) => void;

let stageTwoSeeder: StageTwoSeeder | undefined;

export function installStageTwoSeeder(seeder: StageTwoSeeder): void {
  stageTwoSeeder = seeder;
}

export interface RunEntry {
  run: Run;
  record: RunRecord;
}

export interface HoldRegistration {
  phase: string;
  runId: string | null;
}

export interface SimulationControls {
  seed: number;
  stepCostUsd: number;
  holds: HoldRegistration[];
  held: Map<string, string>;
  releasers: Map<string, () => void>;
}

export type OrdinalKind = "run" | "plan";

export const DEFAULT_VERDICT_SEED = 1;

function defaultControls(): SimulationControls {
  return {
    seed: DEFAULT_VERDICT_SEED,
    stepCostUsd: 0,
    holds: [],
    held: new Map(),
    releasers: new Map(),
  };
}

interface StageTwoData {
  plans: Plan[];
  scenarios: ScenarioRecord[];
  runs: RunEntry[];
  runScenarioIds: Map<string, string>;
  runScenarioRows: Map<string, RunScenario>;
  runScenariosByRun: Map<string, RunScenario[]>;
  steps: Map<string, StepRecord>;
  browserSessions: BrowserSession[];
  artifacts: Map<string, ArtifactDef>;
  ordinals: Record<OrdinalKind, number>;
}

function emptyData(): StageTwoData {
  return {
    plans: [],
    scenarios: [],
    runs: [],
    runScenarioIds: new Map(),
    runScenarioRows: new Map(),
    runScenariosByRun: new Map(),
    steps: new Map(),
    browserSessions: [],
    artifacts: new Map(),
    ordinals: { run: 0, plan: 0 },
  };
}

export interface FeedControl {
  open: () => number;
  drop: () => number;
}

export class StageTwoStore {
  readonly clock = new SimulationClock();
  controls: SimulationControls = defaultControls();
  feedControl: FeedControl = { open: () => 0, drop: () => 0 };
  private readonly state: MockState;
  private seedName: StageTwoSeed = "gracie";
  private seeded = false;
  private data: StageTwoData = emptyData();
  private readonly teardown: Array<() => void> = [];

  constructor(state: MockState) {
    this.state = state;
  }

  get currentSeed(): StageTwoSeed {
    return this.seedName;
  }

  onReset(callback: () => void): void {
    this.teardown.push(callback);
  }

  reset(seed: StageTwoSeed = "gracie"): void {
    for (const callback of this.teardown) {
      callback();
    }
    this.clock.reset();
    this.controls = defaultControls();
    this.data = emptyData();
    this.seedName = seed;
    this.seeded = false;
  }

  ensure(): void {
    if (this.seeded) {
      return;
    }
    if (stageTwoSeeder === undefined) {
      throw new Error("The stage 2 seeder is not installed; import mocks/stage2/seed first");
    }
    this.seeded = true;
    stageTwoSeeder(this.state, this, this.seedName);
  }

  nextOrdinal(kind: OrdinalKind): number {
    this.ensure();
    this.data.ordinals[kind] += 1;
    return this.data.ordinals[kind];
  }

  get plans(): Plan[] {
    this.ensure();
    return this.data.plans;
  }

  get scenarios(): ScenarioRecord[] {
    this.ensure();
    return this.data.scenarios;
  }

  get runs(): RunEntry[] {
    this.ensure();
    return this.data.runs;
  }

  get browserSessions(): BrowserSession[] {
    this.ensure();
    return this.data.browserSessions;
  }

  findPlan(id: string): Plan | undefined {
    return this.plans.find((plan) => plan.id === id);
  }

  addPlan(plan: Plan): void {
    this.plans.push(plan);
  }

  removePlan(id: string): boolean {
    const before = this.plans.length;
    this.data.plans = this.data.plans.filter((plan) => plan.id !== id);
    return this.data.plans.length !== before;
  }

  findScenario(id: string): ScenarioRecord | undefined {
    return this.scenarios.find((entry) => entry.scenario.id === id);
  }

  scenarioByCell(targetId: string, cellKey: string): ScenarioRecord | undefined {
    return this.scenarios.find(
      (entry) => entry.cellKey === cellKey && entry.scenario.target_id === targetId,
    );
  }

  addScenario(entry: ScenarioRecord): void {
    this.scenarios.push(entry);
  }

  findRun(id: string): RunEntry | undefined {
    return this.runs.find((entry) => entry.run.id === id);
  }

  findRunRecord(id: string): RunRecord | undefined {
    return this.findRun(id)?.record;
  }

  addRun(entry: RunEntry): void {
    this.runs.push(entry);
  }

  removeRun(runId: string): boolean {
    const index = this.runs.findIndex((entry) => entry.run.id === runId);
    if (index < 0) {
      return false;
    }
    this.runs.splice(index, 1);
    const rows = this.data.runScenariosByRun.get(runId) ?? [];
    const rowIds = new Set(rows.map((row) => row.id));
    for (const row of rows) {
      this.data.runScenarioIds.delete(row.id);
      this.data.runScenarioRows.delete(row.id);
      for (const summary of row.steps) {
        const record = this.data.steps.get(summary.id);
        for (const def of record?.defs ?? []) {
          this.data.artifacts.delete(def.id);
        }
        this.data.steps.delete(summary.id);
      }
    }
    this.data.runScenariosByRun.delete(runId);
    this.data.browserSessions = this.data.browserSessions.filter(
      (session) => !rowIds.has(session.run_scenario_id),
    );
    return true;
  }

  addRunScenario(runId: string, row: RunScenario): void {
    this.ensure();
    this.data.runScenarioIds.set(row.id, runId);
    this.data.runScenarioRows.set(row.id, row);
    const rows = this.data.runScenariosByRun.get(runId) ?? [];
    rows.push(row);
    this.data.runScenariosByRun.set(runId, rows);
  }

  scenariosOfRun(runId: string): RunScenario[] {
    this.ensure();
    return this.data.runScenariosByRun.get(runId) ?? [];
  }

  findRunScenario(id: string): RunScenario | undefined {
    this.ensure();
    return this.data.runScenarioRows.get(id);
  }

  runIdOfRunScenario(id: string): string | undefined {
    this.ensure();
    return this.data.runScenarioIds.get(id);
  }

  addBrowserSession(session: BrowserSession): void {
    this.browserSessions.push(session);
  }

  sessionsOfRun(runId: string): BrowserSession[] {
    const rowIds = new Set(this.scenariosOfRun(runId).map((row) => row.id));
    return this.browserSessions.filter((session) => rowIds.has(session.run_scenario_id));
  }

  addStep(record: StepRecord, summary: StepSummary, row: RunScenario): void {
    this.ensure();
    this.data.steps.set(record.step.id, record);
    for (const def of record.defs) {
      this.data.artifacts.set(def.id, def);
    }
    row.steps.push(summary);
  }

  findStep(id: string): StepRecord | undefined {
    this.ensure();
    return this.data.steps.get(id);
  }

  stepsOfRunScenario(runScenarioId: string, attempt: number): Step[] {
    const row = this.findRunScenario(runScenarioId);
    if (row === undefined) {
      return [];
    }
    return row.steps.flatMap((summary) => {
      const record = this.data.steps.get(summary.id);
      return record !== undefined && record.step.attempt === attempt ? [record.step] : [];
    });
  }

  findArtifact(id: string): ArtifactDef | undefined {
    this.ensure();
    return this.data.artifacts.get(id);
  }
}
