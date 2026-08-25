import type { Finding, FindingSummary } from "@/lib/api/types";

const DEFAULT_TIMESTAMP = "2026-10-04T09:00:00.000Z";
const DEFAULT_RUN_ID = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9a01";
const FINGERPRINT_LENGTH = 16;

export type FindingInput = Partial<Finding> & Pick<Finding, "id" | "target_id">;

export function buildFinding(input: FindingInput): Finding {
  const firstSeenAt = input.first_seen_at ?? DEFAULT_TIMESTAMP;
  const firstSeenRunId = input.first_seen_run_id ?? DEFAULT_RUN_ID;
  return {
    fingerprint: input.id.replaceAll("-", "").slice(-FINGERPRINT_LENGTH),
    title: "Untitled finding",
    class: "wrong_result",
    severity: "medium",
    status: "new",
    invariant_id: null,
    scenario_id: null,
    first_seen_at: firstSeenAt,
    last_seen_at: firstSeenAt,
    first_seen_run_id: firstSeenRunId,
    last_seen_run_id: firstSeenRunId,
    occurrence_count: 1,
    ticket_url: null,
    known_gap_reason: null,
    promoted_scenario_id: null,
    latest_explanation: null,
    expected: null,
    actual: null,
    ...input,
  };
}

export function toFindingSummary(finding: Finding): FindingSummary {
  return {
    id: finding.id,
    target_id: finding.target_id,
    fingerprint: finding.fingerprint,
    title: finding.title,
    class: finding.class,
    severity: finding.severity,
    status: finding.status,
    invariant_id: finding.invariant_id,
    scenario_id: finding.scenario_id,
    first_seen_at: finding.first_seen_at,
    last_seen_at: finding.last_seen_at,
    occurrence_count: finding.occurrence_count,
    ticket_url: finding.ticket_url,
    known_gap_reason: finding.known_gap_reason,
    promoted_scenario_id: finding.promoted_scenario_id,
  };
}
