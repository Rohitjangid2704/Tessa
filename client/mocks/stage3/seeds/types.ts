import type { SeedHashSource, SeedResetStatus } from "@/lib/api/types";

export const SEED_STATES = [
  "matched",
  "never_reset",
  "mismatch",
  "first_reset",
  "no_reset_script",
  "reset_fails",
] as const;

export type SeedState = (typeof SEED_STATES)[number];

export type SeedsSeed = "default" | "empty";

export type SeedAction = "verify" | "reset";

export interface SeedRecord {
  id: string;
  targetId: string;
  version: number;
  declaredHash: string | null;
  hashSource: SeedHashSource;
  currentHash: string;
  resetHash: string;
  observedHash: string | null;
  lastResetAt: string | null;
  lastResetStatus: SeedResetStatus | null;
  lastResetRunId: string | null;
  hasResetScript: boolean;
  hasHashCommand: boolean;
  resetScriptPath: string | null;
  hashCommand: string | null;
  materialSha256: string;
  resetFails: boolean;
}

export interface SeedRunPlan {
  action: SeedAction;
  seedId: string;
  resetFailed: boolean;
  observedHash: string | null;
  expectedHash: string | null;
  matched: boolean;
  recordedHash: string | null;
  failureReason: string | null;
}
