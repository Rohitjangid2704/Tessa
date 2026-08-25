import { MockApiError, notFound } from "../factories/errors";
import type { ParsedPlanCreate } from "../stage2/plan-service";
import { resolveBundle } from "../stage2/plan-service";
import type { MockState } from "../state";
import type { ErrorDetail } from "../types";
import type { RunTrigger } from "@/lib/api/types";
import { subsetStore } from "./subset-store";

export const AGENT_TRIGGER = "agent" as unknown as RunTrigger;

export interface SubsetSelection {
  create: ParsedPlanCreate;
  scenarioIds: string[];
  cellKeys: ReadonlySet<string>;
  featureIds: ReadonlySet<string>;
}

function notRunnable(details: ErrorDetail[]): MockApiError {
  return new MockApiError(
    422,
    "scenarios_not_runnable",
    `${details.length} scenario${details.length === 1 ? " is" : "s are"} not runnable`,
    details,
  );
}

export function resolveSubset(
  state: MockState,
  targetId: string,
  scenarioIds: readonly string[],
): SubsetSelection {
  const target = state.stageOne.findTarget(targetId);
  if (target === undefined) {
    throw notFound("Target not found");
  }
  const forced = subsetStore.variant === "not_runnable";
  const details: ErrorDetail[] = [];
  const cellKeys = new Set<string>();
  const featureIds = new Set<string>();
  for (const id of scenarioIds) {
    const entry = state.stageTwo.findScenario(id);
    const runnable =
      !forced &&
      entry !== undefined &&
      entry.scenario.target_id === target.id &&
      entry.scenario.status === "accepted";
    if (!runnable) {
      details.push({
        loc: ["body", "scenario_ids"],
        code: id,
        message: "The scenario is not accepted or does not belong to the target",
      });
    } else if (entry.cellKey !== null) {
      cellKeys.add(entry.cellKey);
    } else if (entry.scenario.feature_id !== null) {
      featureIds.add(entry.scenario.feature_id);
    }
  }
  if (details.length > 0) {
    throw notRunnable(details);
  }
  const record = resolveBundle(state.stageOne, target, null);
  return {
    create: {
      targetId: target.id,
      bundleId: null,
      name: null,
      saved: false,
      selection: {
        feature_ids: record.features.map((feature) => feature.feature_id),
        area_ids: [],
        roles: ["all"],
        depth: "smoke",
        interface_mode: "both",
        k: 1,
      },
    },
    scenarioIds: [...scenarioIds],
    cellKeys,
    featureIds,
  };
}
