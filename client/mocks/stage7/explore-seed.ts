import { ADMIN_USER, MEMBER_USER } from "../factories/users";
import { launchRun } from "../server/run-simulator";
import { STAGE_ONE_IDS } from "../stage1/seed";
import type { BundleRecord, TargetRecord } from "../stage1/store";
import { stableId } from "../stage2/ids";
import { buildConfigSnapshot } from "../stage2/plan-service";
import type { StageTwoStore } from "../stage2/store";
import { mockState, type MockState } from "../state";
import type { Budget } from "@/lib/api/types";
import "../streams/explore-script";
import { exploreStore } from "./explore-store";
import { registerStageSevenSeeder } from "./seeding";

interface SeededExploration {
  key: string;
  runAt: string;
  createdBy: string;
  role: string;
  goalText: string;
  params: Record<string, unknown>;
}

const SEEDED_BUDGET: Budget = { max_usd: 2, max_minutes: 15 };

const SEEDED_EXPLORATIONS: readonly SeededExploration[] = [
  {
    key: "private-document",
    runAt: "2026-10-03T16:00:00.000Z",
    createdBy: MEMBER_USER.id,
    role: "housekeeping_lead",
    goalText: "As a team member, try to see a private document",
    params: { variant: "findings", reuse_findings: true },
  },
  {
    key: "guest-isolation",
    runAt: "2026-10-03T17:10:00.000Z",
    createdBy: ADMIN_USER.id,
    role: "guest",
    goalText: "Check that a guest cannot see other guests' requests",
    params: { variant: "clean" },
  },
  {
    key: "stopped-early",
    runAt: "2026-10-03T18:20:00.000Z",
    createdBy: MEMBER_USER.id,
    role: "front_desk",
    goalText: "Try to change another guest's booking",
    params: { variant: "findings", reuse_findings: true, stop_after_action: 5 },
  },
];

export function seededExplorationRunId(key: string): string {
  return stableId("run_explore_seed", key);
}

export const SEEDED_EXPLORATION_KEYS: readonly string[] = SEEDED_EXPLORATIONS.map(
  (entry) => entry.key,
);

export function seedExplorationHistory(
  state: MockState,
  store: StageTwoStore,
  target: TargetRecord,
  record: BundleRecord,
): void {
  for (const entry of SEEDED_EXPLORATIONS) {
    const id = seededExplorationRunId(entry.key);
    if (store.findRun(id) !== undefined) {
      continue;
    }
    const runAtMs = Date.parse(entry.runAt);
    launchRun(state, store, {
      kind: "explore",
      createdBy: entry.createdBy,
      targetId: target.id,
      planId: null,
      bundleId: record.bundle.id,
      readOnly: false,
      budget: SEEDED_BUDGET,
      configSnapshot: buildConfigSnapshot(record, entry.runAt),
      params: { goal_text: entry.goalText, role: entry.role, ...entry.params },
      id,
      createdAtMs: runAtMs,
      mode: { kind: "instant", baseMs: runAtMs },
    });
    exploreStore.register({ runId: id, goalText: entry.goalText, role: entry.role });
  }
}

export function clearExplorationRuns(store: StageTwoStore): number {
  const rows = store.runs;
  let removed = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.run.kind === "explore") {
      rows.splice(index, 1);
      removed += 1;
    }
  }
  exploreStore.reset();
  return removed;
}

function reseedExplorations(seed: "default" | "empty"): void {
  const store = mockState.stageTwo;
  clearExplorationRuns(store);
  if (seed === "empty") {
    return;
  }
  const target = mockState.stageOne.findTarget(STAGE_ONE_IDS.gracie);
  const record = target === undefined ? undefined : mockState.stageOne.latestValidBundle(target.id);
  if (target !== undefined && record !== undefined) {
    seedExplorationHistory(mockState, store, target, record);
  }
}

registerStageSevenSeeder("explore", reseedExplorations);
