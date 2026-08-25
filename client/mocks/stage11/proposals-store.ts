import type { BundleRecord, TargetRecord } from "../stage1/store";
import { GRACIE_SEEDED_BRANCH, GRACIE_SEEDED_COMMIT_SHA, STAGE_ONE_IDS } from "../stage1/seed";
import { ADMIN_USER, MEMBER_USER } from "../factories/users";
import { stableId } from "../stage2/ids";
import { coverageStore } from "../stage6/coverage-store";
import { mockState, type MockState } from "../state";
import {
  buildSeedItems,
  PROPOSAL_DEFAULT_ITEMS,
  PROPOSAL_LARGE_ITEMS,
  type FeatureSeed,
  type ProposalItemRecord,
  type ProposalRecord,
  type ProposalsVariant,
} from "./proposals-data";

const SEED_AGE_MS = 26 * 3_600_000;

function featureSeedsOf(target: TargetRecord, record: BundleRecord): FeatureSeed[] {
  const dataset = coverageStore.datasetFor(target, record);
  if (dataset.rows.length > 0) {
    return dataset.rows
      .map((row) => ({
        featureId: row.feature_id,
        area: row.area,
        title: row.title,
        interfaceIds: [
          ...new Set(
            dataset.cells
              .filter((cell) => cell.featureId === row.feature_id)
              .map((cell) => cell.interfaceId),
          ),
        ],
      }))
      .filter((feature) => feature.interfaceIds.length > 0);
  }
  return record.features.map((feature) => ({
    featureId: feature.feature_id,
    area: feature.area,
    title: feature.description.trim().replace(/\.$/, ""),
    interfaceIds: feature.interface_ids,
  }));
}

export class ProposalsStore {
  private variant: ProposalsVariant = "default";
  private readonly records = new Map<string, ProposalRecord>();
  private readonly retiredItemIds = new Set<string>();
  private readonly materialized = new Set<string>();

  get currentVariant(): ProposalsVariant {
    return this.variant;
  }

  load(variant: ProposalsVariant): void {
    this.variant = variant;
    this.records.clear();
    this.retiredItemIds.clear();
    this.materialized.clear();
  }

  reset(): void {
    this.load("default");
  }

  current(targetId: string, state: MockState = mockState): ProposalRecord | undefined {
    this.materialize(state, targetId);
    return this.records.get(targetId);
  }

  findItem(
    itemId: string,
    state: MockState = mockState,
  ): { record: ProposalRecord; item: ProposalItemRecord } | "retired" | undefined {
    for (const targetId of new Set([...this.records.keys(), STAGE_ONE_IDS.gracie])) {
      const record = this.current(targetId, state);
      const item = record?.items.find((candidate) => candidate.id === itemId);
      if (record !== undefined && item !== undefined) {
        return { record, item };
      }
    }
    return this.retiredItemIds.has(itemId) ? "retired" : undefined;
  }

  replace(record: ProposalRecord): void {
    const previous = this.records.get(record.target_id);
    if (previous !== undefined) {
      for (const item of previous.items) {
        this.retiredItemIds.add(item.id);
      }
    }
    this.materialized.add(record.target_id);
    this.records.set(record.target_id, record);
  }

  private materialize(state: MockState, targetId: string): void {
    if (this.materialized.has(targetId)) {
      return;
    }
    this.materialized.add(targetId);
    if (this.variant === "empty" || targetId !== STAGE_ONE_IDS.gracie) {
      return;
    }
    const target = state.stageOne.findTarget(targetId);
    const latest = target === undefined ? undefined : state.stageOne.latestValidBundle(targetId);
    if (target === undefined || latest === undefined) {
      return;
    }
    const count = this.variant === "large" ? PROPOSAL_LARGE_ITEMS : PROPOSAL_DEFAULT_ITEMS;
    const generatedAt = Date.now() - SEED_AGE_MS;
    const bundles = state.stageOne.bundlesOf(targetId);
    const earlier = bundles.find((entry) => entry.bundle.id !== latest.bundle.id);
    const bundleId =
      this.variant === "stale"
        ? (earlier?.bundle.id ?? stableId("proposal_old_bundle", targetId))
        : latest.bundle.id;
    this.records.set(targetId, {
      id: stableId("proposal", targetId, this.variant),
      target_id: targetId,
      bundle_id: bundleId,
      commit_sha: GRACIE_SEEDED_COMMIT_SHA,
      branch: GRACIE_SEEDED_BRANCH,
      generated_at: new Date(generatedAt).toISOString(),
      source: "bundle",
      created_by: ADMIN_USER.id,
      created_at: new Date(generatedAt).toISOString(),
      items: buildSeedItems({
        features: featureSeedsOf(target, latest),
        count,
        createdBy: ADMIN_USER.id,
        selectedBy: MEMBER_USER.id,
        selectedAtBase: Date.now(),
      }),
    });
  }
}

export const proposalsStore = new ProposalsStore();

mockState.stageTwo.onReset(() => proposalsStore.reset());
