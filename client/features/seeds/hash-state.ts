import type { Seed, SeedHashSource, SeedPhase, SeedPhaseStatus, SeedResetStatus } from "./types";

export type HashState = "match" | "mismatch" | "unknown";

export const HASH_STATE_LABELS: Record<HashState, string> = {
  match: "Match",
  mismatch: "Mismatch",
  unknown: "Unknown",
};

export const HASH_SOURCE_LABELS: Record<SeedHashSource, string> = {
  bundle: "Bundle manifest",
  first_reset: "First reset",
};

export const RESET_STATUS_LABELS: Record<SeedResetStatus, string> = {
  ok: "OK",
  failed: "Failed",
  mismatch: "Mismatch",
};

export const SEED_PHASES = ["reset", "hash", "assert"] as const satisfies readonly SeedPhase[];

export const SEED_PHASE_LABELS: Record<SeedPhase, string> = {
  reset: "Reset",
  hash: "Hash",
  assert: "Assert",
};

export const SEED_PHASE_STATUS_LABELS: Record<SeedPhaseStatus, string> = {
  started: "Running",
  ok: "OK",
  failed: "Failed",
};

export const NOT_RECORDED_YET = "Recorded at first reset";
export const NOT_CHECKED_YET = "Not checked yet";

export function hashStateOf(hashes: {
  declared: string | null;
  observed: string | null;
}): HashState {
  if (hashes.declared === null || hashes.observed === null) {
    return "unknown";
  }
  return hashes.declared === hashes.observed ? "match" : "mismatch";
}

export function seedHashState(seed: Pick<Seed, "declared_hash" | "observed_hash">): HashState {
  return hashStateOf({ declared: seed.declared_hash, observed: seed.observed_hash });
}

export function describeHashState(
  state: HashState,
  hashes: { declared: string | null; observed: string | null },
): string {
  if (state === "match") {
    return "The data has the declared hash.";
  }
  if (state === "mismatch") {
    return "The data does not have the declared hash. Reset it to the seed, then verify again.";
  }
  if (hashes.declared === null) {
    return "No hash is declared yet. The first successful reset records the observed hash as the expected one and never reports a mismatch.";
  }
  return "The hash has not been read yet. Verify reads it and compares it with the declared one.";
}

export const HASH_PREVIEW_CHARACTERS = 12;

export function abbreviateHash(hash: string): string {
  return hash.length > HASH_PREVIEW_CHARACTERS ? `${hash.slice(0, HASH_PREVIEW_CHARACTERS)}…` : hash;
}
