import type { ScenarioOrigin, ScenarioStatus } from "@/lib/api/types";

export const SCENARIO_STATUSES = [
  "draft",
  "validating",
  "invalid",
  "in_review",
  "accepted",
  "rejected",
  "quarantined",
  "retired",
] as const satisfies readonly ScenarioStatus[];

export const SCENARIO_STATUS_LABELS = {
  draft: "Draft",
  validating: "Validating",
  invalid: "Invalid",
  in_review: "In review",
  accepted: "Accepted",
  rejected: "Rejected",
  quarantined: "Quarantined",
  retired: "Retired",
} as const satisfies Record<ScenarioStatus, string>;

export const SCENARIO_ORIGINS = [
  "bundle_example",
  "generated",
  "authored",
  "promoted_finding",
  "explorer",
  "replay",
  "manual",
] as const satisfies readonly ScenarioOrigin[];

export const SCENARIO_ORIGIN_LABELS = {
  bundle_example: "Bundle example",
  generated: "Generated",
  authored: "Authored",
  promoted_finding: "Promoted finding",
  explorer: "Explorer",
  replay: "Replay",
  manual: "Manual",
} as const satisfies Record<ScenarioOrigin, string>;

export const SCENARIO_SORT_KEYS = ["created_at", "updated_at", "title"] as const;

export const DEFAULT_SCENARIO_SORT = "-created_at";
