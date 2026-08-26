import { mockState } from "@/mocks/handlers";
import type { BundleRecord } from "@/mocks/stage1/store";
import { STAGE_ONE_IDS } from "@/tests/utils/stage1";

export function seededBundle(targetId: string, version: number): BundleRecord {
  const record = mockState.stageOne
    .bundlesOf(targetId)
    .find((entry) => entry.bundle.version === version);
  if (record === undefined) {
    throw new Error(`target ${targetId} has no version ${version}`);
  }
  return record;
}

export const GRACIE_ID = STAGE_ONE_IDS.gracie;
export const BILLING_ID = STAGE_ONE_IDS.billing;
export const BROKEN_IMPORT_ID = STAGE_ONE_IDS.brokenImport;

export function gracieVersion(version: 1 | 2): BundleRecord {
  return seededBundle(GRACIE_ID, version);
}

export function brokenImportBundle(): BundleRecord {
  return seededBundle(BROKEN_IMPORT_ID, 1);
}
