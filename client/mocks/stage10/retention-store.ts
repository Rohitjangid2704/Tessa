import type { RetentionPolicy, RetentionState, RetentionSweepResult } from "@/lib/api/types";
import { mockState } from "../state";

export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 3650;

export const RETENTION_VARIANTS = ["with_sweep", "never_swept"] as const;

export type RetentionVariant = (typeof RETENTION_VARIANTS)[number];

const DEFAULT_POLICY: RetentionPolicy = {
  steps_days: 90,
  artifacts_days: 30,
  run_events_days: 30,
};

const SEEDED_SWEEP: RetentionSweepResult = {
  at: "2026-10-06T03:00:00.000Z",
  deleted_steps: 1284,
  deleted_artifacts: 312,
  deleted_events: 58120,
};

export class RetentionStore {
  private policy: RetentionPolicy = { ...DEFAULT_POLICY };
  private lastSweep: RetentionSweepResult | null = { ...SEEDED_SWEEP };
  private variant: RetentionVariant = "with_sweep";

  get currentVariant(): RetentionVariant {
    return this.variant;
  }

  load(variant: RetentionVariant): void {
    this.policy = { ...DEFAULT_POLICY };
    this.lastSweep = variant === "with_sweep" ? { ...SEEDED_SWEEP } : null;
    this.variant = variant;
  }

  read(): RetentionState {
    return {
      policy: { ...this.policy },
      last_sweep: this.lastSweep === null ? null : { ...this.lastSweep },
    };
  }

  write(policy: RetentionPolicy): RetentionPolicy {
    this.policy = { ...policy };
    return { ...this.policy };
  }

  reset(): void {
    this.load("with_sweep");
  }
}

export const retentionStore = new RetentionStore();

mockState.stageTwo.onReset(() => retentionStore.reset());
