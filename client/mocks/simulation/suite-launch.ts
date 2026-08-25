import { launchRun } from "../server/run-simulator";
import type { ExpandedCell } from "../stage2/expand";
import {
  baseUrlResolver,
  buildConfigSnapshot,
  ensureScenarios,
  failedInterfaceIds,
  featureOf,
} from "../stage2/plan-service";
import type { RunEntry, StageTwoStore } from "../stage2/store";
import type { BundleRecord, TargetRecord } from "../stage1/store";
import type { MockState } from "../state";
import type { Budget, RunTrigger } from "@/lib/api/types";
import {
  buildScenarioDraft,
  type AttemptOutcome,
  type DraftSource,
  type ScenarioDraft,
} from "./drafts";
import { extensions } from "./extensions";
import type { ContextMode } from "./run-context";
import { buildSuiteScript, type ScriptedEnding } from "./suite-script";

export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 8;

export interface SuiteLaunch {
  state: MockState;
  store: StageTwoStore;
  createdBy: string;
  target: TargetRecord;
  record: BundleRecord;
  planId: string | null;
  attempts: number;
  budget: Budget;
  cells: readonly ExpandedCell[];
  readOnly: boolean;
  concurrency?: number;
  resetSeed?: boolean;
  budgetExhausted?: boolean;
  verdictFlaky?: boolean;
  trigger?: RunTrigger;
  scenarioIds?: readonly string[];
  ending?: ScriptedEnding;
  outcomeOverrides?: ReadonlyMap<string, AttemptOutcome[]>;
  mode?: ContextMode;
  createdAtMs?: number;
  id?: string;
  drafts?: (runId: string) => ScenarioDraft[];
}

export function launchSuiteRun(input: SuiteLaunch): RunEntry {
  const { state, store, target, record, cells } = input;
  const createdAtMs = input.createdAtMs ?? Date.now();
  const createdAt = new Date(createdAtMs).toISOString();
  const scenarios = ensureScenarios(store, target, record, cells, createdAt);
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY),
  );
  const environment = {
    baseUrlOf: baseUrlResolver(state.stageOne, target.id),
    failedInterfaces: failedInterfaceIds(target),
  };
  const verdictSeed = store.controls.seed;

  const buildDrafts = (runId: string): ScenarioDraft[] => {
    if (input.drafts !== undefined) {
      return input.drafts(runId);
    }
    const cellByKey = new Map(cells.map((cell) => [cell.key, cell]));
    return scenarios.flatMap((entry) => {
      const cell = entry.cellKey === null ? undefined : cellByKey.get(entry.cellKey);
      if (cell === undefined) {
        return [];
      }
      const source: DraftSource = {
        scenario: entry.scenario,
        feature: featureOf(record, cell.featureId),
        interfaceKind: cell.interfaceKind,
        productionBlocked: cell.productionBlocked,
        outcomes: input.outcomeOverrides?.get(cell.key),
      };
      return [
        buildScenarioDraft(source, {
          runId,
          attempts: input.attempts,
          seed: verdictSeed,
          verdictFlaky: input.verdictFlaky ?? false,
          readOnly: input.readOnly,
          environment,
        }),
      ];
    });
  };

  const scenarioVersions = Object.fromEntries(
    scenarios.map((entry) => [entry.scenario.id, entry.scenario.version]),
  );
  return launchRun(state, store, {
    kind: "suite",
    createdBy: input.createdBy,
    targetId: target.id,
    planId: input.planId,
    bundleId: record.bundle.id,
    readOnly: input.readOnly,
    budget: input.budget,
    configSnapshot: {
      ...buildConfigSnapshot(record, createdAt, scenarioVersions),
      ...(input.scenarioIds === undefined ? {} : { scenario_ids: [...input.scenarioIds] }),
    },
    trigger: input.trigger,
    mode: input.mode,
    createdAtMs,
    id: input.id,
    params: { reset_seed: input.resetSeed ?? false },
    script: (run) => {
      const seeding =
        input.resetSeed === true && extensions.seedingPhase !== null
          ? extensions.seedingPhase(
              { run, targetId: target.id, params: { reset_seed: true } },
              store,
            )
          : null;
      return buildSuiteScript({
        drafts: buildDrafts(run.id),
        concurrency,
        budget: input.budget,
        budgetExhausted: input.budgetExhausted ?? false,
        stepCostUsd: store.controls.stepCostUsd,
        seedKey: String(verdictSeed),
        seeding,
        ending: input.ending,
      });
    },
  });
}
