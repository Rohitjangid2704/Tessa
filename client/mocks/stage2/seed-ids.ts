import { stepFixtureGroups, type StepFixtureGroup } from "../fixtures/steps";
import { runScenarioIdOf } from "../simulation/drafts";
import { STAGE_ONE_IDS } from "../stage1/seed";
import { cellKey } from "./expand";
import { stableId } from "./ids";

export function smokeScenarioId(
  targetId: string,
  featureId: string,
  role: string,
  interfaceId: string,
): string {
  return stableId("scenario", targetId, cellKey(featureId, role, interfaceId));
}

const RUN_IDS = {
  completed: stableId("seed_run", "completed"),
  previousCompleted: stableId("seed_run", "previous_completed"),
  flaky: stableId("seed_run", "flaky"),
  failed: stableId("seed_run", "failed"),
  canceled: stableId("seed_run", "canceled"),
  budgetExceeded: stableId("seed_run", "budget_exceeded"),
  showcase: stableId("seed_run", "showcase"),
  production: stableId("seed_run", "production"),
} as const;

export function fixtureScenarioId(group: StepFixtureGroup, targetId: string): string {
  return smokeScenarioId(targetId, group.cell.feature_id, group.cell.role, group.cell.interface_id);
}

export function fixtureRunScenarioId(group: StepFixtureGroup, runId: string): string {
  return runScenarioIdOf(runId, fixtureScenarioId(group, STAGE_ONE_IDS.gracie));
}

export function fixtureStepId(
  groupKey: string,
  name: string,
  runId: string = RUN_IDS.showcase,
): string {
  const group = stepFixtureGroups().find((entry) => entry.key === groupKey);
  if (group === undefined) {
    throw new Error(`no step fixture group ${groupKey}`);
  }
  for (const [attempt, drafted] of group.attempts.entries()) {
    const index = drafted.steps.findIndex((step) => step.name === name);
    if (index >= 0) {
      return stableId("step", fixtureRunScenarioId(group, runId), attempt, index);
    }
  }
  throw new Error(`no step fixture ${name} in group ${groupKey}`);
}

function baseStepIds(): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const group of stepFixtureGroups()) {
    for (const drafted of group.attempts) {
      for (const step of drafted.steps) {
        ids[step.name] = fixtureStepId(group.key, step.name);
      }
    }
  }
  return ids;
}

export const STAGE_TWO_IDS = {
  plans: {
    smartLog: stableId("seed_plan", "smart_log"),
    guestFlows: stableId("seed_plan", "guest_flows"),
    apiSweep: stableId("seed_plan", "api_sweep"),
    lowBudget: stableId("seed_plan", "low_budget"),
  },
  runs: RUN_IDS,
  steps: baseStepIds(),
} as const;

export const SHOWCASE_RUN_SCENARIO_IDS: Readonly<Record<string, string>> = Object.fromEntries(
  stepFixtureGroups().map((group) => [group.key, fixtureRunScenarioId(group, RUN_IDS.showcase)]),
);
