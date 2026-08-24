import type {
  Depth,
  ProposalItemStatus,
  ProposalKind,
  ProposalNeed,
  ProposalReason,
  ProposalRisk,
} from "@/lib/api/types";

export const PROPOSAL_RISKS = ["high", "medium", "low"] as const satisfies readonly ProposalRisk[];

export const PROPOSAL_STATUSES = [
  "proposed",
  "selected",
  "declined",
  "authored",
  "covered",
] as const satisfies readonly ProposalItemStatus[];

export const PROPOSAL_RISK_LABELS: Record<ProposalRisk, string> = {
  high: "High risk",
  medium: "Medium risk",
  low: "Low risk",
};

export const PROPOSAL_STATUS_LABELS: Record<ProposalItemStatus, string> = {
  proposed: "Proposed",
  selected: "Selected",
  declined: "Declined",
  authored: "Authored",
  covered: "Covered",
};

export const PROPOSAL_STATUS_DESCRIPTIONS: Record<ProposalItemStatus, string> = {
  proposed: "Waiting for the team to tick or decline it",
  selected: "Ticked by the team, ready to plan or author",
  declined: "Declined by the team, left out of plans and markers",
  authored: "Scenarios were authored for it, so it can no longer be changed",
  covered: "Every coverage cell it maps to is covered",
};

export const PROPOSAL_KIND_LABELS: Record<ProposalKind, string> = {
  api: "API",
  browser: "Browser",
  stream: "Stream",
  webhook: "Webhook",
  pipeline: "Pipeline",
  contract: "Contract",
  integration: "Integration",
};

export const PROPOSAL_REASON_LABELS: Record<ProposalReason, string> = {
  recent_change: "Recent change",
  no_unit_tests: "No unit tests",
  auth_path: "Auth path",
  money_path: "Money path",
  migration: "Migration",
  complexity: "Complexity",
  bug_history: "Bug history",
  external_dependency: "External dependency",
  user_visible: "User visible",
};

export const PROPOSAL_NEED_LABELS: Record<ProposalNeed, string> = {
  seed: "Needs a seed",
  db_read: "Needs a database read",
  hook: "Needs a hook",
  flag: "Needs a flag",
  fixture: "Needs a fixture",
  credentials: "Needs credentials",
};

export const PROPOSAL_DEPTH_LABELS: Record<Depth, string> = {
  smoke: "Smoke depth",
  standard: "Standard depth",
  deep: "Deep depth",
};

export const PROPOSAL_SORTS = ["risk", "title", "confidence"] as const;

export type ProposalSort = (typeof PROPOSAL_SORTS)[number];

export const PROPOSAL_SORT_LABELS: Record<ProposalSort, string> = {
  risk: "Risk, highest first",
  title: "Title",
  confidence: "Confidence, lowest first",
};
