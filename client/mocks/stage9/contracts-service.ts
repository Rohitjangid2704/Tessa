import { MockApiError, validationFailed } from "../factories/errors";
import { launchRun } from "../server/run-simulator";
import { BodyReader, type Source } from "../stage1/body";
import type { BundleRecord } from "../stage1/store";
import { stableId } from "../stage2/ids";
import { buildConfigSnapshot } from "../stage2/plan-service";
import { nowIso } from "../stage2/support";
import type { MockState } from "../state";
import type { MockUser } from "../types";
import type { ContractCheck, ContractCheckCreate, ContractDiff, RunHandle } from "@/lib/api/types";
import "../streams/contract-script";
import {
  BREAKING_CHECK_ITEMS,
  COMPATIBLE_CHECK_ITEMS,
  DEFAULT_ITEM_GAP_MS,
  FAILING_AFTER_ITEMS,
  FAILING_REASON,
  SLOW_ITEM_GAP_MS,
  cloneItems,
  countBreaking,
  type ContractBehavior,
} from "./contracts-data";
import { contractStore, type ContractEntry, type ContractRunParams } from "./contracts-store";

export const CONTRACT_RUN_BUDGET = { max_usd: 0.01, max_minutes: 5 } as const;

export function parseContractCheckCreate(body: Source): ContractCheckCreate {
  const reader = new BodyReader(body);
  const consumerBundleId = reader.uuid("consumer_bundle_id", { required: true });
  const providerBundleId = reader.uuid("provider_bundle_id", { required: true });
  if (reader.details.length > 0 || !consumerBundleId || !providerBundleId) {
    throw validationFailed(reader.details);
  }
  return { consumer_bundle_id: consumerBundleId, provider_bundle_id: providerBundleId };
}

function requireValidBundle(state: MockState, bundleId: string, field: string): BundleRecord {
  const record = state.stageOne.findBundle(bundleId);
  if (record === undefined) {
    throw new MockApiError(404, "not_found", "Bundle not found", [
      { loc: ["body", field], code: "not_found", message: "Bundle not found" },
    ]);
  }
  if (record.bundle.validation_status !== "valid") {
    throw validationFailed([
      {
        loc: ["body", field],
        code: "bundle_invalid",
        message: `Bundle version ${record.bundle.version} did not validate`,
      },
    ]);
  }
  return record;
}

export function planItems(
  behavior: ContractBehavior,
  consumer: BundleRecord,
  provider: BundleRecord,
): ContractDiff[] {
  if (behavior === "empty") {
    return [];
  }
  if (behavior === "compatible") {
    return cloneItems(COMPATIBLE_CHECK_ITEMS);
  }
  if (behavior === "failing" || behavior === "slow") {
    return cloneItems(BREAKING_CHECK_ITEMS);
  }
  if (consumer.bundle.id === provider.bundle.id) {
    return [];
  }
  if (consumer.bundle.target_id === provider.bundle.target_id) {
    return cloneItems(COMPATIBLE_CHECK_ITEMS);
  }
  return cloneItems(BREAKING_CHECK_ITEMS);
}

export function toContractCheck(state: MockState, entry: ContractEntry): ContractCheck {
  const visible = cloneItems(entry.items.slice(0, entry.revealed));
  return {
    id: entry.id,
    run_id: entry.runId,
    consumer_bundle_id: entry.consumerBundleId,
    provider_bundle_id: entry.providerBundleId,
    status: state.stageTwo.findRun(entry.runId)?.run.status ?? "queued",
    breaking: countBreaking(visible),
    items: visible,
    created_at: entry.createdAt,
  };
}

export function startContractCheck(
  state: MockState,
  user: MockUser,
  body: ContractCheckCreate,
): RunHandle {
  const consumer = requireValidBundle(state, body.consumer_bundle_id, "consumer_bundle_id");
  const provider = requireValidBundle(state, body.provider_bundle_id, "provider_bundle_id");
  const store = state.stageTwo;
  store.ensure();
  const behavior = contractStore.consumeBehavior();
  const items = planItems(behavior, consumer, provider);
  const createdAt = nowIso();
  const failing = behavior === "failing" && items.length > FAILING_AFTER_ITEMS;
  const entry: ContractEntry = {
    id: stableId("contract_check_live", contractStore.entries.length + 1),
    runId: stableId("run_live", store.nextOrdinal("run")),
    consumerBundleId: consumer.bundle.id,
    providerBundleId: provider.bundle.id,
    consumerTargetId: consumer.bundle.target_id,
    providerTargetId: provider.bundle.target_id,
    createdAt,
    items,
    revealed: 0,
    failAfter: failing ? FAILING_AFTER_ITEMS : null,
    failReason: failing ? FAILING_REASON : null,
    itemGapMs: behavior === "slow" ? SLOW_ITEM_GAP_MS : DEFAULT_ITEM_GAP_MS,
  };
  contractStore.add(entry);
  const params: ContractRunParams = { contract_check_id: entry.id };
  const launched = launchRun(state, store, {
    id: entry.runId,
    kind: "contract",
    createdBy: user.id,
    targetId: consumer.bundle.target_id,
    planId: null,
    bundleId: consumer.bundle.id,
    readOnly: false,
    budget: { ...CONTRACT_RUN_BUDGET },
    configSnapshot: buildConfigSnapshot(consumer, createdAt),
    params: { ...params },
  });
  return {
    run_id: launched.run.id,
    workflow_id: launched.run.workflow_id,
    kind: launched.run.kind,
    status: launched.run.status,
    created_at: launched.run.created_at,
  };
}
