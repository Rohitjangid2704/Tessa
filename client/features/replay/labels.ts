import type { ReplayReasonCode, ReplayRecordStatus } from "@/lib/api/types";

export const REPLAY_PRODUCTION_BLOCKED_REASON =
  "production_blocked: an export is dry-run against the target, so replays are never run on a production target. Pick a QA target.";

export const REPLAY_PRIVACY_NOTICE_TITLE = "Production exports hold real conversations";

export const REPLAY_PRIVACY_NOTICE_LINES: readonly string[] = [
  "Names, emails and phone numbers are redacted when Tessa reads the file, and only redacted excerpts of at most 200 characters are kept.",
  "The uploaded file is deleted after it is parsed. Do not upload an export you are not allowed to test with.",
  "Nothing from the file is written to the browser console or to any log from this page.",
];

export const REPLAY_RECORD_STATUS_LABELS = {
  pending: "Waiting",
  created: "Case created",
  rejected: "Rejected",
} as const satisfies Record<ReplayRecordStatus, string>;

export const REPLAY_REASON_LABELS = {
  duplicate: "Duplicate",
  unstable: "Unstable",
  invalid: "Invalid",
  over_record_cap: "Over the record cap",
  validation_failed: "Validation failed",
} as const satisfies Record<ReplayReasonCode, string>;

export const REPLAY_REASON_EXPLANATIONS = {
  duplicate: "The same conversation appeared earlier in the export.",
  unstable: "The case did not give the same result on repeated dry runs.",
  invalid: "The record has no conversation_id or no messages.",
  over_record_cap: "The export has more records than the server reads; this one was skipped.",
  validation_failed: "The case drafted from this record did not validate.",
} as const satisfies Record<ReplayReasonCode, string>;

export const UNKNOWN_REASON_LABEL = "Rejected without a reason code";
