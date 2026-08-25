import { ADMIN_USER } from "../factories/users";
import type { BundleRecord, TargetRecord } from "../stage1/store";
import { stableId } from "../stage2/ids";
import { DEFAULT_RUN_BUDGET } from "../stage2/plan-service";
import { nowIso } from "../stage2/support";
import type { StageTwoStore } from "../stage2/store";
import { mockState } from "../state";
import type { Plan } from "@/lib/api/types";
import {
  buildCoverageDataset,
  DEFAULT_COVERAGE_SEED,
  type CoverageCellState,
  type CoverageDataset,
  type CoverageSeed,
} from "./coverage-data";

export interface LocatedCell {
  dataset: CoverageDataset;
  cell: CoverageCellState;
}

export class CoverageStore {
  private currentSeed: CoverageSeed = DEFAULT_COVERAGE_SEED;
  private readonly datasets = new Map<string, CoverageDataset>();

  get seed(): CoverageSeed {
    return this.currentSeed;
  }

  get datasetCount(): number {
    return this.datasets.size;
  }

  reset(seed: CoverageSeed = DEFAULT_COVERAGE_SEED): void {
    this.currentSeed = seed;
    this.datasets.clear();
  }

  datasetFor(target: TargetRecord, record: BundleRecord): CoverageDataset {
    const key = `${target.id}:${record.bundle.id}`;
    const existing = this.datasets.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = buildCoverageDataset(record, target.id, this.currentSeed);
    this.datasets.set(key, created);
    return created;
  }

  findDataset(targetId: string, bundleId: string): CoverageDataset | undefined {
    return this.datasets.get(`${targetId}:${bundleId}`);
  }

  findCell(cellId: string): LocatedCell | undefined {
    for (const dataset of this.datasets.values()) {
      const cell = dataset.cells.find((candidate) => candidate.id === cellId);
      if (cell !== undefined) {
        return { dataset, cell };
      }
    }
    return undefined;
  }
}

export const coverageStore = new CoverageStore();

mockState.stageTwo.onReset(() => coverageStore.reset());

export function ensureBaselinePlan(
  store: StageTwoStore,
  target: TargetRecord,
  record: BundleRecord,
  cellsTotal: number,
): Plan {
  const existing = store.plans.find(
    (plan) =>
      plan.is_coverage_baseline &&
      plan.target_id === target.id &&
      plan.bundle_id === record.bundle.id,
  );
  if (existing !== undefined) {
    existing.cells_total = cellsTotal;
    return existing;
  }
  const plan: Plan = {
    id: stableId("plan_baseline", target.id, record.bundle.id),
    target_id: target.id,
    bundle_id: record.bundle.id,
    name: null,
    saved: false,
    selection: {
      feature_ids: [],
      area_ids: [],
      roles: ["all"],
      interface_mode: "both",
      depth: "smoke",
      k: 1,
    },
    effective_budget: { ...DEFAULT_RUN_BUDGET },
    is_coverage_baseline: true,
    cells_total: cellsTotal,
    schedule_id: null,
    created_by: ADMIN_USER.id,
    created_at: nowIso(),
  };
  store.addPlan(plan);
  return plan;
}
