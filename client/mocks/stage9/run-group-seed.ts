import { ADMIN_USER, MEMBER_USER } from "../factories/users";
import { GRACIE_SEEDED_VALUES, SEEDED_VARIABLE_SET_AT } from "../fixtures/gracie-env";
import { launchSuiteRun, type SuiteLaunch } from "../simulation/suite-launch";
import { ingestBundle } from "../stage1/ingest";
import { STAGE_ONE_IDS, STAGE_ONE_ORIGIN } from "../stage1/seed";
import type { BundleRecord, TargetRecord } from "../stage1/store";
import { expandSelection } from "../stage2/expand";
import { buildPlan, DEFAULT_RUN_BUDGET, type Evaluation } from "../stage2/plan-service";
import { seedTargetLibrary } from "../stage2/seed";
import { STAGE_TWO_IDS } from "../stage2/seed-ids";
import type { StageTwoStore } from "../stage2/store";
import type { MockState } from "../state";
import type { Plan, PlanSelection } from "@/lib/api/types";
import { RUN_GROUP_IDS } from "./run-group-ids";
import { runGroupStore } from "./run-group-store";
import { registerStageNineSeeder, type StageNineSeed } from "./seeding";

const MINUTE_MS = 60_000;

const SEED_TIMES = {
  bundles: "2026-09-13T08:00:00.000Z",
  plans: "2026-10-01T09:30:00.000Z",
  completedGroup: "2026-10-04T12:00:00.000Z",
  failedGroup: "2026-10-05T09:30:00.000Z",
} as const;

function serviceUrlOf(targetId: string): string | undefined {
  if (targetId === STAGE_ONE_IDS.billing) {
    return "https://billing.qa.example.test";
  }
  return targetId === STAGE_ONE_IDS.liveShop ? "https://shop.qa.example.test" : undefined;
}

const BILLING_READS: PlanSelection = {
  feature_ids: [],
  area_ids: ["Reports"],
  roles: [],
  interface_mode: "api_only",
  depth: "smoke",
  k: 1,
};

const LIVE_SHOP_READS: PlanSelection = {
  feature_ids: ["smart_log.read.open_maintenance", "smart_log.write.close_issue"],
  area_ids: [],
  roles: ["housekeeping_lead", "manager"],
  interface_mode: "both",
  depth: "smoke",
  k: 1,
};

export interface RunGroupSeedSummary {
  run_groups: number;
  run_group_ids: string[];
  plan_ids: string[];
}

function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * MINUTE_MS).toISOString();
}

function fillEnvironment(state: MockState, target: TargetRecord): void {
  const url = serviceUrlOf(target.id);
  for (const entry of state.stageOne.environmentOf(target.id)) {
    if (entry.stale || entry.value !== null) {
      continue;
    }
    const value = GRACIE_SEEDED_VALUES[entry.name] ?? (entry.kind === "url" ? url : undefined);
    if (value !== undefined) {
      entry.value = value;
      entry.last_set_at = SEEDED_VARIABLE_SET_AT;
      entry.last_set_by = ADMIN_USER.id;
    }
  }
}

function prepareTarget(
  state: MockState,
  store: StageTwoStore,
  targetId: string,
): { target: TargetRecord; record: BundleRecord } | null {
  const target = state.stageOne.findTarget(targetId);
  if (target === undefined) {
    return null;
  }
  const hadBundle = state.stageOne.latestValidBundle(target.id) !== undefined;
  const record =
    state.stageOne.latestValidBundle(target.id) ??
    ingestBundle({
      store: state.stageOne,
      target,
      kind: "valid",
      source: "zip",
      note: "Prepared for the multi-target story",
      uploadedBy: ADMIN_USER.id,
      origin: STAGE_ONE_ORIGIN,
      now: SEED_TIMES.bundles,
    }).record;
  fillEnvironment(state, target);
  if (!hadBundle) {
    seedTargetLibrary(store, target, record);
  }
  return { target, record };
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

function ensurePlan(
  store: StageTwoStore,
  target: TargetRecord,
  record: BundleRecord,
  seed: { id: string; name: string; selection: PlanSelection; createdAt: string },
): Plan {
  const existing = store.findPlan(seed.id);
  if (existing !== undefined) {
    return existing;
  }
  const plan = buildPlan(
    store,
    {
      targetId: target.id,
      bundleId: record.bundle.id,
      name: seed.name,
      saved: true,
      selection: seed.selection,
    },
    evaluationFor(target, record, seed.selection),
    ADMIN_USER.id,
    seed.createdAt,
    seed.id,
  );
  store.addPlan(plan);
  return plan;
}

const SEEDED_GROUP_IDS: ReadonlySet<string> = new Set(Object.values(RUN_GROUP_IDS.groups));

function removeRunGroups(store: StageTwoStore, keepSeeded: boolean): void {
  const groups = runGroupStore(store);
  for (const group of [...groups.all]) {
    if (keepSeeded && SEEDED_GROUP_IDS.has(group.id)) {
      continue;
    }
    for (const runId of group.runIds) {
      store.removeRun(runId);
    }
    groups.remove(group.id);
  }
}

interface MemberSeed {
  runId: string;
  target: TargetRecord;
  record: BundleRecord;
  plan: Plan;
  runAt: string;
  createdBy: string;
  readOnly: boolean;
  ending?: SuiteLaunch["ending"];
}

function launchMember(
  state: MockState,
  store: StageTwoStore,
  groupId: string,
  member: MemberSeed,
): string {
  const { target, record, plan } = member;
  const entry = launchSuiteRun({
    state,
    store,
    target,
    record,
    planId: plan.id,
    attempts: plan.selection.k,
    budget: plan.effective_budget,
    cells: evaluationFor(target, record, plan.selection).expansion.cells,
    readOnly: member.readOnly,
    createdBy: member.createdBy,
    id: member.runId,
    createdAtMs: Date.parse(member.runAt),
    mode: { kind: "instant", baseMs: Date.parse(member.runAt) },
    ending: member.ending,
  });
  entry.run.run_group_id = groupId;
  return entry.run.id;
}

function seedGroup(
  store: StageTwoStore,
  groupId: string,
  createdBy: string,
  createdAt: string,
  launch: (groupId: string) => string[],
): void {
  const groups = runGroupStore(store);
  if (groups.find(groupId) === undefined) {
    groups.add({ id: groupId, runIds: launch(groupId), createdBy, createdAt });
  }
}

function seedDefault(state: MockState): RunGroupSeedSummary {
  const store = state.stageTwo;
  removeRunGroups(store, true);
  const billing = prepareTarget(state, store, STAGE_ONE_IDS.billing);
  const liveShop = prepareTarget(state, store, STAGE_ONE_IDS.liveShop);
  const gracie = state.stageOne.findTarget(STAGE_ONE_IDS.gracie);
  const gracieRecord =
    gracie === undefined ? undefined : state.stageOne.latestValidBundle(gracie.id);
  const gracieSmartLog = store.findPlan(STAGE_TWO_IDS.plans.smartLog);
  const planIds: string[] = [];
  const billingPlan =
    billing === null
      ? null
      : ensurePlan(store, billing.target, billing.record, {
          id: RUN_GROUP_IDS.plans.billing,
          name: "Billing API reads",
          selection: BILLING_READS,
          createdAt: SEED_TIMES.plans,
        });
  const liveShopPlan =
    liveShop === null
      ? null
      : ensurePlan(store, liveShop.target, liveShop.record, {
          id: RUN_GROUP_IDS.plans.liveShop,
          name: "Shop reads, read-only",
          selection: LIVE_SHOP_READS,
          createdAt: plusMinutes(SEED_TIMES.plans, 5),
        });
  for (const plan of [billingPlan, liveShopPlan]) {
    if (plan !== null) {
      planIds.push(plan.id);
    }
  }
  if (
    gracie === undefined ||
    gracieRecord === undefined ||
    gracieSmartLog === undefined ||
    billing === null ||
    billingPlan === null ||
    liveShop === null ||
    liveShopPlan === null
  ) {
    return { run_groups: 0, run_group_ids: [], plan_ids: planIds };
  }
  const gracieMember = (runId: string, runAt: string, createdBy: string): MemberSeed => ({
    runId,
    target: gracie,
    record: gracieRecord,
    plan: gracieSmartLog,
    runAt,
    createdBy,
    readOnly: false,
  });

  seedGroup(
    store,
    RUN_GROUP_IDS.groups.completed,
    ADMIN_USER.id,
    SEED_TIMES.completedGroup,
    (groupId) => [
      launchMember(
        state,
        store,
        groupId,
        gracieMember(RUN_GROUP_IDS.runs.completed.gracie, SEED_TIMES.completedGroup, ADMIN_USER.id),
      ),
      launchMember(state, store, groupId, {
        runId: RUN_GROUP_IDS.runs.completed.billing,
        target: billing.target,
        record: billing.record,
        plan: billingPlan,
        runAt: plusMinutes(SEED_TIMES.completedGroup, 1),
        createdBy: ADMIN_USER.id,
        readOnly: false,
      }),
      launchMember(state, store, groupId, {
        runId: RUN_GROUP_IDS.runs.completed.liveShop,
        target: liveShop.target,
        record: liveShop.record,
        plan: liveShopPlan,
        runAt: plusMinutes(SEED_TIMES.completedGroup, 2),
        createdBy: ADMIN_USER.id,
        readOnly: true,
      }),
    ],
  );

  seedGroup(
    store,
    RUN_GROUP_IDS.groups.failed,
    MEMBER_USER.id,
    SEED_TIMES.failedGroup,
    (groupId) => [
      launchMember(
        state,
        store,
        groupId,
        gracieMember(RUN_GROUP_IDS.runs.failed.gracie, SEED_TIMES.failedGroup, MEMBER_USER.id),
      ),
      launchMember(state, store, groupId, {
        runId: RUN_GROUP_IDS.runs.failed.billing,
        target: billing.target,
        record: billing.record,
        plan: billingPlan,
        runAt: plusMinutes(SEED_TIMES.failedGroup, 1),
        createdBy: MEMBER_USER.id,
        readOnly: false,
        ending: {
          kind: "failed",
          atFraction: 0.4,
          reason: "The worker lost its Temporal connection",
        },
      }),
    ],
  );

  return {
    run_groups: runGroupStore(store).all.length,
    run_group_ids: runGroupStore(store).all.map((group) => group.id),
    plan_ids: planIds,
  };
}

function seedEmpty(state: MockState): RunGroupSeedSummary {
  const store = state.stageTwo;
  removeRunGroups(store, false);
  for (const planId of Object.values(RUN_GROUP_IDS.plans)) {
    store.removePlan(planId);
  }
  return { run_groups: 0, run_group_ids: [], plan_ids: [] };
}

export function seedRunGroups(seed: StageNineSeed, state: MockState): RunGroupSeedSummary {
  return seed === "empty" ? seedEmpty(state) : seedDefault(state);
}

registerStageNineSeeder("run-groups", seedRunGroups);
