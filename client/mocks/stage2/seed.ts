import "../fixtures/step-fixture-modules";
import { ADMIN_USER, MEMBER_USER } from "../factories/users";
import { stepFixtureGroups } from "../fixtures/steps";
import { runScenarioIdOf, type AttemptOutcome, type ScenarioDraft } from "../simulation/drafts";
import { launchSuiteRun, type SuiteLaunch } from "../simulation/suite-launch";
import { STAGE_ONE_IDS } from "../stage1/seed";
import type { BundleRecord, TargetRecord } from "../stage1/store";
import { buildReviewQueueScenarios } from "../stage6/review-queue";
import { seedExplorationHistory } from "../stage7/explore-seed";
import { resetRedteamReplayStores, seedRedteamReplayHistory } from "../stage7/redteam-replay-seed";
import { ensureMutationSeed } from "../stage8/mutation-seed";
import "../stage9/seed-modules";
import { applyStageNineSeed } from "../stage9/seeding";
import type { MockState } from "../state";
import type { Plan, PlanSelection } from "@/lib/api/types";
import { cellKey, expandSelection } from "./expand";
import { stableId } from "./ids";
import { buildLibraryExtras } from "./library";
import { buildPlan, DEFAULT_RUN_BUDGET, ensureScenarios, type Evaluation } from "./plan-service";
import { STAGE_TWO_IDS } from "./seed-ids";
import { installStageTwoSeeder, type StageTwoStore } from "./store";

export type StageTwoSeed = "gracie" | "empty";

export { STAGE_TWO_IDS };

const MINUTE_MS = 60_000;

const SEED_TIMES = {
  plans: "2026-10-01T09:00:00.000Z",
  budgetExceeded: "2026-10-01T15:20:00.000Z",
  canceled: "2026-10-02T11:05:00.000Z",
  previousCompleted: "2026-10-02T14:30:00.000Z",
  failed: "2026-10-02T16:45:00.000Z",
  flaky: "2026-10-03T09:30:00.000Z",
  completed: "2026-10-03T14:10:00.000Z",
  showcase: "2026-10-04T08:00:00.000Z",
  production: "2026-10-04T10:00:00.000Z",
} as const;

const SMART_LOG_FEATURES = ["smart_log.read.open_maintenance", "smart_log.read.issue_detail"];

const SMART_LOG: PlanSelection = {
  feature_ids: SMART_LOG_FEATURES,
  area_ids: [],
  roles: [],
  interface_mode: "both",
  depth: "smoke",
  k: 1,
};

const GUEST_FLOWS: PlanSelection = {
  feature_ids: [],
  area_ids: ["Guest Requests"],
  roles: ["guest"],
  interface_mode: "browser_only",
  depth: "smoke",
  k: 2,
  budget: { max_usd: 2, max_minutes: 15 },
};

const API_SWEEP: PlanSelection = {
  feature_ids: [],
  area_ids: ["Account & Access", "Reports", "Streaming & Jobs"],
  roles: [],
  interface_mode: "api_only",
  depth: "smoke",
  k: 2,
};

const LOW_BUDGET: PlanSelection = { ...SMART_LOG, budget: { max_usd: 0.25, max_minutes: 10 } };

const PRODUCTION_READS: PlanSelection = {
  feature_ids: ["smart_log.read.open_maintenance", "smart_log.write.close_issue"],
  area_ids: [],
  roles: ["housekeeping_lead", "manager"],
  interface_mode: "both",
  depth: "smoke",
  k: 1,
};

interface PlanSeed {
  id: string;
  name: string | null;
  saved: boolean;
  selection: PlanSelection;
  createdAt: string;
  createdBy: string;
}

function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * MINUTE_MS).toISOString();
}

function evaluationFor(
  target: TargetRecord,
  record: BundleRecord,
  selection: PlanSelection,
): Evaluation {
  return {
    target,
    record,
    expansion: expandSelection(record, selection, { productionTier: target.tier === "production" }),
    budget: selection.budget ?? { ...DEFAULT_RUN_BUDGET },
  };
}

function seedPlan(
  store: StageTwoStore,
  target: TargetRecord,
  record: BundleRecord,
  seed: PlanSeed,
): Plan {
  const plan = buildPlan(
    store,
    {
      targetId: target.id,
      bundleId: record.bundle.id,
      name: seed.name,
      saved: seed.saved,
      selection: seed.selection,
    },
    evaluationFor(target, record, seed.selection),
    seed.createdBy,
    seed.createdAt,
    seed.id,
  );
  store.addPlan(plan);
  return plan;
}

function showcaseDrafts(
  store: StageTwoStore,
  target: TargetRecord,
  runId: string,
): ScenarioDraft[] {
  return stepFixtureGroups().flatMap((group) => {
    const key = cellKey(group.cell.feature_id, group.cell.role, group.cell.interface_id);
    const entry = store.scenarioByCell(target.id, key);
    if (entry === undefined) {
      return [];
    }
    const { scenario } = entry;
    return [
      {
        runScenarioId: runScenarioIdOf(runId, scenario.id),
        scenario,
        role: group.cell.role,
        interfaceId: group.cell.interface_id,
        family: scenario.family,
        title: scenario.title,
        skip: null,
        attemptsTotal: group.attempts.length,
        attempts: group.attempts.map((attempt) => ({
          outcome: attempt.outcome,
          steps: attempt.steps.map((step) => step.content),
          browser: group.cell.interface_id === "browser",
          lastUrl: null,
        })),
      },
    ];
  });
}

export function seedTargetLibrary(
  store: StageTwoStore,
  target: TargetRecord,
  record: BundleRecord,
): void {
  const everything: PlanSelection = {
    feature_ids: record.features.map((feature) => feature.feature_id),
    area_ids: [],
    roles: [],
    interface_mode: "both",
    depth: "smoke",
    k: 1,
  };
  const { cells } = expandSelection(record, everything, { productionTier: false });
  ensureScenarios(store, target, record, cells, record.bundle.uploaded_at);
  if (target.id !== STAGE_ONE_IDS.gracie) {
    return;
  }
  const libraryContext = {
    targetId: target.id,
    bundleId: record.bundle.id,
    bundleVersion: record.bundle.version,
    baseIso: record.bundle.uploaded_at,
  };
  for (const entry of buildLibraryExtras(libraryContext)) {
    store.addScenario(entry);
  }
  for (const entry of buildReviewQueueScenarios(libraryContext)) {
    store.addScenario(entry);
  }
}

type HistoryLaunch = Partial<SuiteLaunch> & {
  id: string;
  runAt: string;
  createdBy: string;
  plan: Plan | null;
};

function seedGracieHistory(
  state: MockState,
  store: StageTwoStore,
  target: TargetRecord,
  record: BundleRecord,
): void {
  const ids = STAGE_TWO_IDS;
  const plan = (
    id: string,
    name: string | null,
    saved: boolean,
    selection: PlanSelection,
    offset: number,
    createdBy: string,
  ) =>
    seedPlan(store, target, record, {
      id,
      name,
      saved,
      selection,
      createdAt: plusMinutes(SEED_TIMES.plans, offset),
      createdBy,
    });
  const smartLog = plan(ids.plans.smartLog, "Smart Log reads", true, SMART_LOG, 0, ADMIN_USER.id);
  plan(ids.plans.guestFlows, "Guest flows in the browser", true, GUEST_FLOWS, 20, MEMBER_USER.id);
  const apiSweep = plan(
    ids.plans.apiSweep,
    "API sweep, two attempts",
    true,
    API_SWEEP,
    45,
    ADMIN_USER.id,
  );
  const lowBudget = plan(ids.plans.lowBudget, null, false, LOW_BUDGET, 70, MEMBER_USER.id);

  const launch = ({ plan: source, runAt, ...rest }: HistoryLaunch) => {
    const cells =
      source === null ? [] : evaluationFor(target, record, source.selection).expansion.cells;
    return launchSuiteRun({
      state,
      store,
      target,
      record,
      planId: source?.id ?? null,
      attempts: source?.selection.k ?? 1,
      budget: source?.effective_budget ?? { ...DEFAULT_RUN_BUDGET },
      cells,
      readOnly: false,
      createdAtMs: Date.parse(runAt),
      mode: { kind: "instant", baseMs: Date.parse(runAt) },
      ...rest,
    });
  };
  const overrides = (key: string, outcomes: AttemptOutcome[]) => new Map([[key, outcomes]]);

  launch({
    id: ids.runs.budgetExceeded,
    runAt: SEED_TIMES.budgetExceeded,
    createdBy: MEMBER_USER.id,
    plan: lowBudget,
    budgetExhausted: true,
  });
  launch({
    id: ids.runs.canceled,
    runAt: SEED_TIMES.canceled,
    createdBy: ADMIN_USER.id,
    plan: smartLog,
    ending: { kind: "canceled", atFraction: 0.5 },
  });
  launch({
    id: ids.runs.failed,
    runAt: SEED_TIMES.failed,
    createdBy: ADMIN_USER.id,
    plan: smartLog,
    trigger: "api",
    ending: { kind: "failed", atFraction: 0.4, reason: "The worker lost its Temporal connection" },
  });
  launch({
    id: ids.runs.flaky,
    runAt: SEED_TIMES.flaky,
    createdBy: ADMIN_USER.id,
    plan: apiSweep,
    verdictFlaky: true,
    outcomeOverrides: overrides(cellKey("access.read.who_am_i", "admin", "rest_api"), [
      "fail",
      "fail",
    ]),
  });
  launch({
    id: ids.runs.previousCompleted,
    runAt: SEED_TIMES.previousCompleted,
    createdBy: ADMIN_USER.id,
    plan: smartLog,
    outcomeOverrides: new Map<string, AttemptOutcome[]>([
      [cellKey("smart_log.read.issue_detail", "manager", "chat_sse"), ["pass"]],
      [cellKey("smart_log.read.issue_detail", "housekeeping_lead", "chat_sse"), ["fail"]],
      [cellKey("smart_log.read.open_maintenance", "front_desk", "chat_sse"), ["fail"]],
    ]),
  });
  launch({
    id: ids.runs.completed,
    runAt: SEED_TIMES.completed,
    createdBy: MEMBER_USER.id,
    plan: smartLog,
    outcomeOverrides: overrides(cellKey("smart_log.read.issue_detail", "manager", "chat_sse"), [
      "fail",
    ]),
  });
  ensureShowcaseScenarios(store, target, record);
  launch({
    id: ids.runs.showcase,
    runAt: SEED_TIMES.showcase,
    createdBy: ADMIN_USER.id,
    plan: null,
    drafts: (runId) => showcaseDrafts(store, target, runId),
  });
}

function ensureShowcaseScenarios(
  store: StageTwoStore,
  target: TargetRecord,
  record: BundleRecord,
): void {
  const cells = stepFixtureGroups().flatMap((group) => {
    const key = cellKey(group.cell.feature_id, group.cell.role, group.cell.interface_id);
    return expandSelection(
      record,
      {
        feature_ids: [group.cell.feature_id],
        area_ids: [],
        roles: [group.cell.role],
        interface_mode: "both",
        depth: "smoke",
        k: 1,
      },
      { productionTier: false },
    ).cells.filter((cell) => cell.key === key);
  });
  ensureScenarios(store, target, record, cells, record.bundle.uploaded_at);
}

export function seedProductionHistory(
  state: MockState,
  store: StageTwoStore,
  target: TargetRecord,
  record: BundleRecord,
): void {
  if (store.findRun(STAGE_TWO_IDS.runs.production) !== undefined) {
    return;
  }
  const plan = seedPlan(store, target, record, {
    id: stableId("seed_plan", "production"),
    name: null,
    saved: false,
    selection: PRODUCTION_READS,
    createdAt: SEED_TIMES.production,
    createdBy: ADMIN_USER.id,
  });
  launchSuiteRun({
    state,
    store,
    target,
    record,
    planId: plan.id,
    attempts: 1,
    budget: plan.effective_budget,
    cells: evaluationFor(target, record, plan.selection).expansion.cells,
    readOnly: true,
    createdBy: ADMIN_USER.id,
    id: STAGE_TWO_IDS.runs.production,
    createdAtMs: Date.parse(SEED_TIMES.production),
    mode: { kind: "instant", baseMs: Date.parse(SEED_TIMES.production) },
  });
}

export function seedStageTwo(state: MockState, store: StageTwoStore, seed: StageTwoSeed): void {
  resetRedteamReplayStores();
  if (seed === "empty") {
    return;
  }
  for (const target of state.stageOne.targets) {
    const record = state.stageOne.latestValidBundle(target.id);
    if (record === undefined) {
      continue;
    }
    seedTargetLibrary(store, target, record);
    if (target.id === STAGE_ONE_IDS.gracie) {
      seedGracieHistory(state, store, target, record);
      seedRedteamReplayHistory(state, store, target, record);
      seedExplorationHistory(state, store, target, record);
      ensureMutationSeed(state);
    }
  }
  applyStageNineSeed("default", state);
}

installStageTwoSeeder(seedStageTwo);
