import type { Seed } from "@/lib/api/types";
import type { StageOneStore } from "../../stage1/store";
import type { SeedRecord } from "./types";

const NO_BUNDLE_ID = "00000000-0000-0000-0000-000000000000";

export function bundleIdOfSeed(stageOne: StageOneStore, record: SeedRecord): string {
  return stageOne.latestValidBundle(record.targetId)?.bundle.id ?? NO_BUNDLE_ID;
}

export function toSeed(stageOne: StageOneStore, record: SeedRecord): Seed {
  return {
    id: record.id,
    target_id: record.targetId,
    bundle_id: bundleIdOfSeed(stageOne, record),
    version: record.version,
    declared_hash: record.declaredHash,
    hash_source: record.hashSource,
    observed_hash: record.observedHash,
    last_reset_at: record.lastResetAt,
    last_reset_status: record.lastResetStatus,
    last_reset_run_id: record.lastResetRunId,
    has_reset_script: record.hasResetScript,
    has_hash_command: record.hasHashCommand,
    reset_script_path: record.resetScriptPath,
    hash_command: record.hashCommand,
    material_sha256: record.materialSha256,
  };
}
