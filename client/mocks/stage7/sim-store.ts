import type { MockState } from "../state";
import type { SimSession } from "@/lib/api/types";
import { GoalStore, type GoalSeed } from "./goal-store";
import { PersonaStore, type PersonaSeed } from "./persona-store";
import type { SimOutcomeMode } from "./sim-plan";

export type SimulatorsSeed = PersonaSeed & GoalSeed;

export const DEFAULT_TURN_MS = 900;

export interface SimulationSettings {
  outcome: SimOutcomeMode;
  turnMs: number;
}

export interface StoredSimSession {
  order: number;
  session: SimSession;
}

export class SimulatorsStore {
  readonly personas = new PersonaStore();
  readonly goals = new GoalStore();
  settings: SimulationSettings = { outcome: "mixed", turnMs: DEFAULT_TURN_MS };
  historySeeded = false;
  private sessionRows: StoredSimSession[] = [];
  private nextOrder = 1;

  reset(seed: SimulatorsSeed = "default"): void {
    this.personas.reset(seed);
    this.goals.reset(seed);
    this.settings = { outcome: "mixed", turnMs: DEFAULT_TURN_MS };
    this.historySeeded = false;
    this.sessionRows = [];
    this.nextOrder = 1;
  }

  configure(change: Partial<SimulationSettings>): void {
    this.settings = { ...this.settings, ...change };
  }

  get sessions(): readonly StoredSimSession[] {
    return this.sessionRows;
  }

  findSession(id: string): SimSession | undefined {
    return this.sessionRows.find((row) => row.session.id === id)?.session;
  }

  addSession(session: SimSession): void {
    this.sessionRows.push({ order: this.nextOrder, session });
    this.nextOrder += 1;
  }

  personaInUse(personaId: string): boolean {
    return this.sessionRows.some((row) => row.session.persona_id === personaId);
  }

  goalInUse(goalId: string): boolean {
    return this.sessionRows.some((row) => row.session.goal_id === goalId);
  }
}

const storesByState = new WeakMap<MockState, SimulatorsStore>();

export function simulatorsOf(state: MockState): SimulatorsStore {
  const existing = storesByState.get(state);
  if (existing !== undefined) {
    return existing;
  }
  const created = new SimulatorsStore();
  storesByState.set(state, created);
  state.stageTwo.onReset(() => created.reset());
  return created;
}
