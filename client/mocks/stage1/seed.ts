import { ADMIN_USER } from "../factories/users";
import { slugify } from "../factories/targets";
import {
  GRACIE_SEEDED_VALUES,
  SEEDED_HEALTH_CHECKED_AT,
  SEEDED_VARIABLE_SET_AT,
} from "../fixtures/gracie-env";
import { runHealthChecks } from "./health";
import { ingestBundle } from "./ingest";
import type { StageOneStore, TargetRecord } from "./store";

export type StageOneSeed = "gracie" | "empty";

export const STAGE_ONE_ORIGIN = "http://localhost:8000";
export const GRACIE_SEEDED_COMMIT_SHA = "9f3c2a1b7d8e4f60a5b1c2d3e4f5a6b7c8d9e0f1";
export const GRACIE_SEEDED_BRANCH = "qa/tessa-bundle";

export const STAGE_ONE_IDS = {
  gracie: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9001",
  billing: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9002",
  liveShop: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9003",
  brokenImport: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9004",
  legacyPortal: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9005",
} as const;

export function fixedToken(label: string): string {
  return `tgt_${label.padEnd(22, "a").slice(0, 22)}`;
}

interface TargetSeed {
  id: string;
  name: string;
  appKind: TargetRecord["appKind"];
  tier: TargetRecord["tier"];
  tokenLabel: string;
  createdAt: string;
  archivedAt?: string;
}

const TARGET_SEEDS: readonly TargetSeed[] = [
  {
    id: STAGE_ONE_IDS.gracie,
    name: "Gracie",
    appKind: "llm_assistant",
    tier: "qa",
    tokenLabel: "graciedemotoken",
    createdAt: "2026-09-10T08:00:00.000Z",
  },
  {
    id: STAGE_ONE_IDS.billing,
    name: "Billing API",
    appKind: "api",
    tier: "qa",
    tokenLabel: "billingapitoken",
    createdAt: "2026-09-12T08:00:00.000Z",
  },
  {
    id: STAGE_ONE_IDS.liveShop,
    name: "Live Shop",
    appKind: "web",
    tier: "production",
    tokenLabel: "liveshoptoken",
    createdAt: "2026-09-14T08:00:00.000Z",
  },
  {
    id: STAGE_ONE_IDS.brokenImport,
    name: "Broken Import",
    appKind: "worker",
    tier: "qa",
    tokenLabel: "brokenimporttoken",
    createdAt: "2026-09-16T08:00:00.000Z",
  },
  {
    id: STAGE_ONE_IDS.legacyPortal,
    name: "Legacy Portal",
    appKind: "cli",
    tier: "qa",
    tokenLabel: "legacyportaltoken",
    createdAt: "2026-09-01T08:00:00.000Z",
    archivedAt: "2026-09-20T08:00:00.000Z",
  },
];

function toRecord(seed: TargetSeed): TargetRecord {
  return {
    id: seed.id,
    name: seed.name,
    slug: slugify(seed.name),
    appKind: seed.appKind,
    tier: seed.tier,
    allowProduction: false,
    targetToken: fixedToken(seed.tokenLabel),
    previousTargetToken: null,
    hints: {},
    createdAt: seed.createdAt,
    createdBy: ADMIN_USER.id,
    archivedAt: seed.archivedAt ?? null,
    healthReport: null,
  };
}

function seedGracieEnvironment(store: StageOneStore, target: TargetRecord): void {
  const entries = store.environmentOf(target.id);
  for (const entry of entries) {
    const value = GRACIE_SEEDED_VALUES[entry.name];
    if (value !== undefined) {
      entry.value = value;
      entry.last_set_at = SEEDED_VARIABLE_SET_AT;
      entry.last_set_by = ADMIN_USER.id;
    }
  }
  const record = store.latestValidBundle(target.id);
  if (record !== undefined) {
    target.healthReport = runHealthChecks({
      record,
      environment: entries,
      previous: null,
      targetId: target.id,
      selected: null,
      checkedAt: SEEDED_HEALTH_CHECKED_AT,
    });
  }
}

function uploadAt(createdAt: string, hours: number): string {
  return new Date(Date.parse(createdAt) + hours * 3_600_000).toISOString();
}

function seedGracie(store: StageOneStore, target: TargetRecord): void {
  const common = {
    store,
    target,
    note: null,
    uploadedBy: ADMIN_USER.id,
    origin: STAGE_ONE_ORIGIN,
  };
  ingestBundle({
    ...common,
    kind: "below_bar",
    source: "zip",
    note: "First pass from Claude Code",
    now: uploadAt(target.createdAt, 2),
  });
  const fixed = ingestBundle({
    ...common,
    kind: "valid",
    source: "zip",
    note: "Fix-up applied",
    now: uploadAt(target.createdAt, 26),
  });
  fixed.record.bundle.commit_sha = GRACIE_SEEDED_COMMIT_SHA;
  fixed.record.bundle.branch = GRACIE_SEEDED_BRANCH;
  seedGracieEnvironment(store, target);
}

export function seedStageOne(store: StageOneStore, seed: StageOneSeed): void {
  if (seed === "empty") {
    return;
  }
  store.targets = TARGET_SEEDS.map(toRecord);
  for (const target of store.targets) {
    if (target.id === STAGE_ONE_IDS.gracie) {
      seedGracie(store, target);
    }
    if (target.id === STAGE_ONE_IDS.brokenImport) {
      ingestBundle({
        store,
        target,
        kind: "invalid",
        source: "zip",
        note: "Zipped before the manifest was finished",
        uploadedBy: ADMIN_USER.id,
        origin: STAGE_ONE_ORIGIN,
        now: uploadAt(target.createdAt, 3),
      });
    }
  }
}
