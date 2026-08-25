import { STAGE_ONE_IDS } from "../../stage1/seed";
import type { BundleRecord } from "../../stage1/store";
import { stableHex, stableId } from "../../stage2/ids";
import type { SeedRecord, SeedState } from "./types";

export const SEED_RESET_SCRIPT_PATH = "seeds/reset.sql";
export const SEED_HASH_SCRIPT_PATH = "seeds/hash.sh";
export const SEED_HASH_COMMAND = "bash seeds/hash.sh";

const HASH_LENGTH = 32;
const MATERIAL_LENGTH = 64;
const RECENT_RESET_AT = "2026-10-04T09:30:00.000Z";
const FIRST_RESET_AT = "2026-09-28T14:05:00.000Z";
const OLD_RESET_AT = "2026-09-20T10:00:00.000Z";

export function seedHash(label: string): string {
  return stableHex(HASH_LENGTH, "seed-hash", label);
}

export function driftedHash(hash: string): string {
  return stableHex(HASH_LENGTH, "seed-drift", hash);
}

export function seedIdOf(targetId: string, version: number): string {
  return stableId("seed", targetId, version);
}

function materialOf(targetId: string, version: number): string {
  return stableHex(MATERIAL_LENGTH, "seed-material", targetId, version);
}

function baseRecord(targetId: string, version: number, label: string): SeedRecord {
  const declared = seedHash(`${label}-${version}`);
  return {
    id: seedIdOf(targetId, version),
    targetId,
    version,
    declaredHash: declared,
    hashSource: "bundle",
    currentHash: declared,
    resetHash: declared,
    observedHash: null,
    lastResetAt: null,
    lastResetStatus: null,
    lastResetRunId: null,
    hasResetScript: true,
    hasHashCommand: true,
    resetScriptPath: SEED_RESET_SCRIPT_PATH,
    hashCommand: SEED_HASH_COMMAND,
    materialSha256: materialOf(targetId, version),
    resetFails: false,
  };
}

function oldestVersion(targetId: string): SeedRecord {
  const record = baseRecord(targetId, 1, "gracie");
  const declared = record.declaredHash ?? "";
  const drifted = driftedHash(declared);
  return {
    ...record,
    currentHash: drifted,
    observedHash: drifted,
    lastResetAt: OLD_RESET_AT,
    lastResetStatus: "mismatch",
  };
}

function recordedAtFirstReset(targetId: string): SeedRecord {
  const record = baseRecord(targetId, 2, "gracie");
  return {
    ...record,
    hashSource: "first_reset",
    observedHash: record.declaredHash,
    lastResetAt: FIRST_RESET_AT,
    lastResetStatus: "ok",
  };
}

function latestVersion(targetId: string, state: SeedState): SeedRecord {
  const record = baseRecord(targetId, 3, "gracie");
  const declared = record.declaredHash ?? "";
  const drifted = driftedHash(declared);
  switch (state) {
    case "matched":
      return {
        ...record,
        observedHash: declared,
        lastResetAt: RECENT_RESET_AT,
        lastResetStatus: "ok",
      };
    case "never_reset":
      return { ...record, currentHash: drifted };
    case "mismatch":
      return {
        ...record,
        currentHash: drifted,
        observedHash: drifted,
        lastResetAt: RECENT_RESET_AT,
        lastResetStatus: "mismatch",
      };
    case "first_reset":
      return {
        ...record,
        declaredHash: null,
        hashSource: "first_reset",
        currentHash: drifted,
        resetHash: seedHash("gracie-3-first-reset"),
      };
    case "no_reset_script":
      return {
        ...record,
        hasResetScript: false,
        resetScriptPath: null,
        observedHash: declared,
        lastResetAt: RECENT_RESET_AT,
        lastResetStatus: "ok",
      };
    case "reset_fails":
      return {
        ...record,
        currentHash: drifted,
        lastResetAt: RECENT_RESET_AT,
        lastResetStatus: "failed",
        resetFails: true,
      };
  }
}

export function gracieSeeds(state: SeedState): SeedRecord[] {
  const targetId = STAGE_ONE_IDS.gracie;
  return [
    oldestVersion(targetId),
    recordedAtFirstReset(targetId),
    latestVersion(targetId, state),
  ];
}

export function carriesSeedMaterial(record: BundleRecord): boolean {
  return record.files.some(
    (file) => file.path === SEED_RESET_SCRIPT_PATH || file.path === SEED_HASH_SCRIPT_PATH,
  );
}

export function generatedSeeds(targetId: string, record: BundleRecord): SeedRecord[] {
  if (!carriesSeedMaterial(record)) {
    return [];
  }
  const seed = baseRecord(targetId, 1, targetId);
  return [{ ...seed, currentHash: driftedHash(seed.declaredHash ?? "") }];
}
