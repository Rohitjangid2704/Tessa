import { MEMBER_USER } from "../factories/users";
import { launchRun } from "../server/run-simulator";
import { STAGE_ONE_IDS } from "../stage1/seed";
import { buildConfigSnapshot } from "../stage2/plan-service";
import { simulationParams } from "../streams/simulate-script";
import type { MockState } from "../state";
import { SIMULATION_HISTORY_ATTEMPTS, SIMULATOR_IDS } from "./sim-ids";
import { simulatorsOf } from "./sim-store";

const HISTORY_STARTED_AT = "2026-10-04T09:00:00.000Z";
const HISTORY_BUDGET = { max_usd: 2, max_minutes: 10 };

export function ensureSimulationHistory(state: MockState): void {
  const simulators = simulatorsOf(state);
  if (simulators.historySeeded) {
    return;
  }
  simulators.historySeeded = true;
  const { personas, goals } = SIMULATOR_IDS;
  const target = state.stageOne.findTarget(STAGE_ONE_IDS.gracie);
  const bundle = state.stageOne.latestValidBundle(STAGE_ONE_IDS.gracie);
  const persona = simulators.personas.find(personas.impatientGuest);
  const goal = simulators.goals.find(goals.brokenAirConditioner);
  if (
    target === undefined ||
    bundle === undefined ||
    persona === undefined ||
    goal === undefined ||
    state.stageTwo.findRun(SIMULATOR_IDS.history.runId) !== undefined
  ) {
    return;
  }
  const startedAtMs = Date.parse(HISTORY_STARTED_AT);
  const params = simulationParams({
    personaId: persona.id,
    goalId: goal.id,
    role: "guest",
    attempts: SIMULATION_HISTORY_ATTEMPTS,
    outcome: "mixed",
  });
  launchRun(state, state.stageTwo, {
    kind: "simulate",
    createdBy: MEMBER_USER.id,
    targetId: target.id,
    planId: null,
    bundleId: bundle.bundle.id,
    readOnly: false,
    budget: HISTORY_BUDGET,
    configSnapshot: buildConfigSnapshot(bundle, HISTORY_STARTED_AT),
    params,
    mode: { kind: "instant", baseMs: startedAtMs },
    id: SIMULATOR_IDS.history.runId,
    createdAtMs: startedAtMs,
  });
}
