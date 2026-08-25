import { slugify } from "../factories/targets";
import type { MockState } from "../state";
import type { CoverageCell, Plan, VerdictStatus } from "@/lib/api/types";
import { expandSelection } from "./expand";
import { stableId } from "./ids";
import type { StageTwoStore } from "./store";

function lastVerdictOf(store: StageTwoStore, plan: Plan, scenarioId: string): VerdictStatus | null {
  const runs = store.runs
    .filter((entry) => entry.run.plan_id === plan.id)
    .sort((left, right) => right.run.created_at.localeCompare(left.run.created_at));
  for (const entry of runs) {
    const row = store
      .scenariosOfRun(entry.run.id)
      .find((candidate) => candidate.scenario_id === scenarioId && candidate.verdict !== null);
    if (row?.verdict !== null && row?.verdict !== undefined) {
      return row.verdict.status;
    }
  }
  return null;
}

export function cellsOfPlan(state: MockState, plan: Plan): CoverageCell[] {
  const { stageOne, stageTwo: store } = state;
  const target = stageOne.findTarget(plan.target_id);
  const record = stageOne.findBundle(plan.bundle_id) ?? stageOne.latestValidBundle(plan.target_id);
  if (target === undefined || record === undefined) {
    return [];
  }
  const expansion = expandSelection(record, plan.selection, {
    productionTier: target.tier === "production",
  });
  return expansion.cells.map((cell): CoverageCell => {
    const scenario = store.scenarioByCell(plan.target_id, cell.key);
    const lastVerdict =
      scenario === undefined ? null : lastVerdictOf(store, plan, scenario.scenario.id);
    return {
      id: stableId("plan_cell", plan.id, cell.key),
      plan_id: plan.id,
      feature_id: cell.featureId,
      role: cell.role,
      interface_id: cell.interfaceId,
      family: slugify(cell.area),
      status: scenario === undefined ? "empty" : lastVerdict === null ? "generated" : "covered",
      scenario_count: scenario === undefined ? 0 : 1,
      last_verdict: lastVerdict,
      reason: null,
      skip_reason: null,
    };
  });
}
