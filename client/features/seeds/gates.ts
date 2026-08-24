import type { Seed } from "./types";

export type SeedAction = "verify" | "reset";

export type SeedGate = { allowed: true } | { allowed: false; reason: string };

export interface SeedGateInput {
  action: SeedAction;
  seed: Pick<Seed, "has_hash_command" | "has_reset_script">;
  production: boolean;
  archived: boolean;
  runActive: boolean;
}

export const PRODUCTION_BLOCKED_REASON =
  "production_blocked: seeds are never verified or reset on a production target, because both write to or probe the live data.";

export const NO_RESET_SCRIPT_REASON =
  "No reset script in the bundle, so there is nothing to run. Add seeds.reset_script to the manifest with the Fix-up prompt, upload the new version and come back.";

export const NO_HASH_COMMAND_REASON =
  "This seed has no hash command, so there is nothing to verify. Add seeds.hash_command to the manifest with the Fix-up prompt and upload the new version.";

export const ARCHIVED_REASON = "This target is archived, so its seed can no longer be changed.";

export const RUN_ACTIVE_REASON = "A seed run is in progress. Wait for it to finish.";

export function seedActionGate({
  action,
  seed,
  production,
  archived,
  runActive,
}: SeedGateInput): SeedGate {
  if (production) {
    return { allowed: false, reason: PRODUCTION_BLOCKED_REASON };
  }
  if (archived) {
    return { allowed: false, reason: ARCHIVED_REASON };
  }
  if (action === "reset" && !seed.has_reset_script) {
    return { allowed: false, reason: NO_RESET_SCRIPT_REASON };
  }
  if (action === "verify" && !seed.has_hash_command) {
    return { allowed: false, reason: NO_HASH_COMMAND_REASON };
  }
  if (runActive) {
    return { allowed: false, reason: RUN_ACTIVE_REASON };
  }
  return { allowed: true };
}
