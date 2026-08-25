import { ADMIN_USER, MEMBER_USER } from "../factories/users";
import { launchRun } from "../server/run-simulator";
import { ingestBundle } from "../stage1/ingest";
import { STAGE_ONE_IDS, STAGE_ONE_ORIGIN } from "../stage1/seed";
import type { BundleRecord, TargetRecord } from "../stage1/store";
import { buildConfigSnapshot } from "../stage2/plan-service";
import type { StageTwoStore } from "../stage2/store";
import { mockState, type MockState } from "../state";
import type { ContractDiff } from "@/lib/api/types";
import {
  BREAKING_CHECK_ITEMS,
  COMPATIBLE_CHECK_ITEMS,
  DEFAULT_ITEM_GAP_MS,
  cloneItems,
} from "./contracts-data";
import { CONTRACT_IDS, CONTRACT_SEED_TIMES } from "./contracts-ids";
import { CONTRACT_RUN_BUDGET } from "./contracts-service";
import { contractStore, type ContractEntry, type ContractRunParams } from "./contracts-store";
import { registerStageNineSeeder, type StageNineSeed } from "./seeding";

const HOTEL_OPERATIONS_NAME = /hotel/i;
const FALLBACK_PROVIDER_UPLOAD_HOURS = 5;
const HOUR_MS = 3_600_000;

interface SeededCheck {
  checkId: string;
  runId: string;
  consumer: BundleRecord;
  provider: BundleRecord;
  items: readonly ContractDiff[];
  at: string;
  createdBy: string;
}

function launchSeededCheck(state: MockState, store: StageTwoStore, seeded: SeededCheck): void {
  const entry: ContractEntry = {
    id: seeded.checkId,
    runId: seeded.runId,
    consumerBundleId: seeded.consumer.bundle.id,
    providerBundleId: seeded.provider.bundle.id,
    consumerTargetId: seeded.consumer.bundle.target_id,
    providerTargetId: seeded.provider.bundle.target_id,
    createdAt: seeded.at,
    items: cloneItems(seeded.items),
    revealed: 0,
    failAfter: null,
    failReason: null,
    itemGapMs: DEFAULT_ITEM_GAP_MS,
  };
  contractStore.add(entry);
  const baseMs = Date.parse(seeded.at);
  const params: ContractRunParams = { contract_check_id: seeded.checkId };
  launchRun(state, store, {
    id: seeded.runId,
    kind: "contract",
    createdBy: seeded.createdBy,
    targetId: seeded.consumer.bundle.target_id,
    planId: null,
    bundleId: seeded.consumer.bundle.id,
    readOnly: false,
    budget: { ...CONTRACT_RUN_BUDGET },
    configSnapshot: buildConfigSnapshot(seeded.consumer, seeded.at),
    params: { ...params },
    createdAtMs: baseMs,
    mode: { kind: "instant", baseMs },
  });
  entry.revealed = entry.items.length;
}

function providerCandidates(state: MockState): TargetRecord[] {
  const { stageOne } = state;
  return stageOne.targets.filter(
    (target) =>
      target.archivedAt === null &&
      target.id !== STAGE_ONE_IDS.gracie &&
      stageOne.latestValidBundle(target.id) !== undefined,
  );
}

function ingestFallbackProvider(state: MockState): BundleRecord | undefined {
  const { stageOne } = state;
  const fallback = stageOne.findTarget(STAGE_ONE_IDS.billing);
  if (fallback === undefined || fallback.archivedAt !== null) {
    return undefined;
  }
  return ingestBundle({
    store: stageOne,
    target: fallback,
    kind: "valid",
    source: "zip",
    note: "Declared interfaces for the contract checks",
    uploadedBy: ADMIN_USER.id,
    origin: STAGE_ONE_ORIGIN,
    now: new Date(
      Date.parse(fallback.createdAt) + FALLBACK_PROVIDER_UPLOAD_HOURS * HOUR_MS,
    ).toISOString(),
  }).record;
}

export function resolveProviderBundle(state: MockState): BundleRecord | undefined {
  const candidates = providerCandidates(state);
  const preferred =
    candidates.find((target) => HOTEL_OPERATIONS_NAME.test(target.name)) ??
    candidates.find((target) => target.tier === "qa") ??
    candidates[0];
  return preferred === undefined
    ? ingestFallbackProvider(state)
    : state.stageOne.latestValidBundle(preferred.id);
}

function seedChecks(state: MockState): void {
  const { stageOne, stageTwo: store } = state;
  const gracie = stageOne.findTarget(STAGE_ONE_IDS.gracie);
  if (gracie === undefined) {
    return;
  }
  const latest = stageOne.latestValidBundle(gracie.id);
  const first = stageOne.bundlesOf(gracie.id).find(
    (record) => record.bundle.validation_status === "valid",
  );
  const provider = resolveProviderBundle(state);
  if (latest === undefined || provider === undefined) {
    return;
  }
  if (first !== undefined && first.bundle.id !== latest.bundle.id) {
    launchSeededCheck(state, store, {
      checkId: CONTRACT_IDS.checks.compatible,
      runId: CONTRACT_IDS.runs.compatible,
      consumer: first,
      provider,
      items: COMPATIBLE_CHECK_ITEMS,
      at: CONTRACT_SEED_TIMES.compatible,
      createdBy: ADMIN_USER.id,
    });
  }
  launchSeededCheck(state, store, {
    checkId: CONTRACT_IDS.checks.breaking,
    runId: CONTRACT_IDS.runs.breaking,
    consumer: latest,
    provider,
    items: BREAKING_CHECK_ITEMS,
    at: CONTRACT_SEED_TIMES.breaking,
    createdBy: MEMBER_USER.id,
  });
}

function bindReset(state: MockState): void {
  if (contractStore.resetBound) {
    return;
  }
  contractStore.resetBound = true;
  state.stageTwo.onReset(() => contractStore.reset());
}

function clearContractRuns(store: StageTwoStore): void {
  const rows = store.runs;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.run.kind === "contract") {
      rows.splice(index, 1);
    }
  }
}

export function ensureContractSeed(state: MockState = mockState): void {
  bindReset(state);
  if (contractStore.seeded) {
    return;
  }
  state.stageTwo.ensure();
  if (contractStore.seeded) {
    return;
  }
  contractStore.seeded = true;
  if (state.stageTwo.currentSeed === "empty") {
    return;
  }
  seedChecks(state);
}

export function reseedContracts(seed: StageNineSeed, state: MockState = mockState) {
  bindReset(state);
  state.stageTwo.ensure();
  clearContractRuns(state.stageTwo);
  contractStore.reset();
  contractStore.seeded = true;
  if (seed === "default" && state.stageTwo.currentSeed !== "empty") {
    seedChecks(state);
  }
  return {
    checks: contractStore.entries.map((entry) => ({
      id: entry.id,
      run_id: entry.runId,
      items: entry.items.length,
    })),
  };
}

registerStageNineSeeder("contracts", reseedContracts);
