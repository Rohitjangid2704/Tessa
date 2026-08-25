import { STAGE_ONE_IDS } from "../stage1/seed";
import type { BundleRecord, StageOneStore, TargetRecord } from "../stage1/store";
import { mockState } from "../state";
import { appendBundleVariant } from "./bundle-variants";

export const LIBRARY_MODES = ["default", "empty"] as const;

export type LibraryMode = (typeof LIBRARY_MODES)[number];

type BaseKind = "valid" | "below_bar" | "invalid";

interface VariantPlan {
  targetId: string;
  donorTargetId: string;
  baseKind: BaseKind;
  source: "zip" | "manifest_paste" | "git";
  note: string | null;
  hoursAfterCreation: number;
  revisionLabel: string | null;
}

const HOUR_MS = 3_600_000;

const VARIANT_PLAN: readonly VariantPlan[] = [
  {
    targetId: STAGE_ONE_IDS.gracie,
    donorTargetId: STAGE_ONE_IDS.gracie,
    baseKind: "valid",
    source: "git",
    note: "Pulled from git (main)",
    hoursAfterCreation: 50,
    revisionLabel: "revised in version 3",
  },
  {
    targetId: STAGE_ONE_IDS.gracie,
    donorTargetId: STAGE_ONE_IDS.gracie,
    baseKind: "below_bar",
    source: "manifest_paste",
    note: "Manifest pasted for a quick check",
    hoursAfterCreation: 74,
    revisionLabel: null,
  },
  {
    targetId: STAGE_ONE_IDS.gracie,
    donorTargetId: STAGE_ONE_IDS.gracie,
    baseKind: "valid",
    source: "zip",
    note: "Added the escalation sweep",
    hoursAfterCreation: 100,
    revisionLabel: "revised in version 5",
  },
  {
    targetId: STAGE_ONE_IDS.gracie,
    donorTargetId: STAGE_ONE_IDS.gracie,
    baseKind: "valid",
    source: "git",
    note: "Pulled from git (release/1.4)",
    hoursAfterCreation: 150,
    revisionLabel: "revised in version 6",
  },
  {
    targetId: STAGE_ONE_IDS.gracie,
    donorTargetId: STAGE_ONE_IDS.gracie,
    baseKind: "below_bar",
    source: "zip",
    note: null,
    hoursAfterCreation: 200,
    revisionLabel: null,
  },
  {
    targetId: STAGE_ONE_IDS.gracie,
    donorTargetId: STAGE_ONE_IDS.gracie,
    baseKind: "valid",
    source: "git",
    note: "Pulled from git (main)",
    hoursAfterCreation: 260,
    revisionLabel: "revised in version 8",
  },
  {
    targetId: STAGE_ONE_IDS.brokenImport,
    donorTargetId: STAGE_ONE_IDS.brokenImport,
    baseKind: "invalid",
    source: "zip",
    note: "Second attempt, still missing the seeds section",
    hoursAfterCreation: 20,
    revisionLabel: null,
  },
  {
    targetId: STAGE_ONE_IDS.legacyPortal,
    donorTargetId: STAGE_ONE_IDS.gracie,
    baseKind: "valid",
    source: "zip",
    note: "Last bundle before the target was archived",
    hoursAfterCreation: 5,
    revisionLabel: "legacy portal",
  },
  {
    targetId: STAGE_ONE_IDS.legacyPortal,
    donorTargetId: STAGE_ONE_IDS.gracie,
    baseKind: "valid",
    source: "git",
    note: "Pulled from git (main)",
    hoursAfterCreation: 30,
    revisionLabel: "legacy portal, pulled",
  },
];

function pickBase(
  store: StageOneStore,
  donor: TargetRecord,
  kind: BaseKind,
): BundleRecord | undefined {
  const bundles = store.bundlesOf(donor.id).filter((record) => {
    const { bundle } = record;
    if (kind === "invalid") {
      return bundle.validation_status === "invalid";
    }
    if (bundle.validation_status !== "valid") {
      return false;
    }
    return kind === "valid"
      ? bundle.completeness.status === "meets_bar"
      : bundle.completeness.status === "below_bar";
  });
  return bundles.at(-1);
}

function uploadAt(createdAt: string, hours: number): string {
  return new Date(Date.parse(createdAt) + hours * HOUR_MS).toISOString();
}

export class LibraryStore {
  mode: LibraryMode = "default";
  private seededFor: BundleRecord[] | null = null;

  ensureSeeded(store: StageOneStore): void {
    if (this.seededFor === store.bundles) {
      return;
    }
    this.seededFor = store.bundles;
    for (const plan of VARIANT_PLAN) {
      const target = store.findTarget(plan.targetId);
      const donor = store.findTarget(plan.donorTargetId);
      if (target === undefined || donor === undefined) {
        continue;
      }
      const base = pickBase(store, donor, plan.baseKind);
      if (base === undefined) {
        continue;
      }
      appendBundleVariant(store, target, {
        base,
        source: plan.source,
        note: plan.note,
        uploadedAt: uploadAt(target.createdAt, plan.hoursAfterCreation),
        revisionLabel: plan.revisionLabel,
      });
    }
  }

  reset(): void {
    this.mode = "default";
  }
}

export const libraryStore = new LibraryStore();

mockState.stageTwo.onReset(() => libraryStore.reset());
