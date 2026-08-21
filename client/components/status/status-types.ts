export const VERDICT_STATUSES = ["pass", "fail", "flaky", "uncertain", "skipped"] as const;
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const VERDICT_TIERS = ["code", "laya", "judge", "human"] as const;
export type VerdictTier = (typeof VERDICT_TIERS)[number];

export const RUN_STATUSES = [
  "queued",
  "planning",
  "seeding",
  "running",
  "canceling",
  "completed",
  "failed",
  "canceled",
  "budget_exceeded",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const HEALTH_STATUSES = ["unchecked", "ok", "failed", "skipped"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const LIVE_STATES = ["live", "reconnecting", "closed", "error"] as const;
export type LiveState = (typeof LIVE_STATES)[number];
