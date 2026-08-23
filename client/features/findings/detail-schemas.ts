import { z } from "zod";
import { SEVERITIES } from "@/components/status/status-types";
import type {
  ExplanationStructured,
  Finding,
  FindingClass,
  FindingStatus,
  FindingUpdate,
  Severity,
} from "@/lib/api/types";
import { safeHttpUrl } from "@/lib/safe-http-url";

export const FINDING_STATUSES = [
  "new",
  "triaged",
  "in_fix",
  "verifying",
  "resolved",
  "known_gap",
  "dismissed",
] as const satisfies readonly FindingStatus[];

export const FINDING_STATUS_LABELS: Record<FindingStatus, string> = {
  new: "New",
  triaged: "Triaged",
  in_fix: "In fix",
  verifying: "Verifying",
  resolved: "Resolved",
  known_gap: "Known gap",
  dismissed: "Dismissed",
};

export const FINDING_CLASS_LABELS: Record<FindingClass, string> = {
  wrong_result: "Wrong result",
  invariant_violation: "Invariant violation",
  server_error: "Server error",
  security_boundary: "Security boundary",
  safety_claim: "Safety claim",
  performance: "Performance",
  accessibility: "Accessibility",
  flaky: "Flaky",
  contract: "Contract",
  harness: "Harness",
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

export const USER_TRANSITIONS: Record<FindingStatus, readonly FindingStatus[]> = {
  new: ["triaged", "in_fix", "known_gap", "dismissed"],
  triaged: ["new", "in_fix", "known_gap", "dismissed"],
  in_fix: ["triaged", "verifying", "known_gap", "dismissed"],
  verifying: ["in_fix", "triaged"],
  resolved: ["triaged"],
  known_gap: ["triaged", "dismissed"],
  dismissed: ["triaged"],
};

export const KNOWN_GAP_REASON_MIN_LENGTH = 3;
export const KNOWN_GAP_REASON_MAX_LENGTH = 500;
export const TICKET_URL_MAX_LENGTH = 2048;
export const PROMOTE_TITLE_MAX_LENGTH = 200;
export const MAX_CODE_REFERENCES = 24;

export const knownGapReasonSchema = z
  .string()
  .trim()
  .min(
    KNOWN_GAP_REASON_MIN_LENGTH,
    `Give a reason of at least ${KNOWN_GAP_REASON_MIN_LENGTH} characters`,
  )
  .max(KNOWN_GAP_REASON_MAX_LENGTH, `Use at most ${KNOWN_GAP_REASON_MAX_LENGTH} characters`);

export const ticketUrlSchema = z
  .string()
  .trim()
  .min(1, "Enter a link, or use Remove to clear it")
  .max(TICKET_URL_MAX_LENGTH, `Use at most ${TICKET_URL_MAX_LENGTH} characters`)
  .refine(
    (value) => safeHttpUrl(value) !== null,
    "Use a link that starts with http:// or https://",
  );

export const promoteTitleSchema = z
  .string()
  .trim()
  .max(PROMOTE_TITLE_MAX_LENGTH, `Use at most ${PROMOTE_TITLE_MAX_LENGTH} characters`);

const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

export function countCharacters(text: string): number {
  return text.length - (text.match(SURROGATE_PAIR)?.length ?? 0);
}

export function explanationSchema(maxChars: number | null) {
  const nonEmpty = z
    .string()
    .refine((value) => value.trim() !== "", "Paste Claude Code's answer first");
  return maxChars === null
    ? nonEmpty
    : nonEmpty.refine(
        (value) => countCharacters(value) <= maxChars,
        `Use at most ${maxChars.toLocaleString("en-US")} characters`,
      );
}

export function isUserTransition(from: FindingStatus, to: FindingStatus): boolean {
  return USER_TRANSITIONS[from].includes(to);
}

export function moveLabel(from: FindingStatus, to: FindingStatus): string {
  if (from === "resolved" && to === "triaged") {
    return "Reopen as Triaged";
  }
  return FINDING_STATUS_LABELS[to];
}

export interface StatusMove {
  from: FindingStatus;
  to: FindingStatus;
}

export type FindingChanges = Readonly<Record<string, { from?: unknown; to?: unknown }>>;

const statusValueSchema = z.enum(FINDING_STATUSES);
const severityValueSchema = z.enum(SEVERITIES);
const nullableTextSchema = z.string().nullable();

export function readStatusMove(changes: FindingChanges): StatusMove | null {
  const change = changes.status;
  if (change === undefined) {
    return null;
  }
  const from = statusValueSchema.safeParse(change.from);
  const to = statusValueSchema.safeParse(change.to);
  return from.success && to.success ? { from: from.data, to: to.data } : null;
}

export function applyFindingChanges(finding: Finding, changes: FindingChanges): Finding {
  const status = statusValueSchema.safeParse(changes.status?.to);
  const severity = severityValueSchema.safeParse(changes.severity?.to);
  const ticketUrl = nullableTextSchema.safeParse(changes.ticket_url?.to);
  const knownGapReason = nullableTextSchema.safeParse(changes.known_gap_reason?.to);
  return {
    ...finding,
    status: status.success ? status.data : finding.status,
    severity: severity.success ? severity.data : finding.severity,
    ticket_url: ticketUrl.success ? ticketUrl.data : finding.ticket_url,
    known_gap_reason: knownGapReason.success ? knownGapReason.data : finding.known_gap_reason,
  };
}

export function describeSystemMove(move: StatusMove): string {
  const from = FINDING_STATUS_LABELS[move.from];
  const to = FINDING_STATUS_LABELS[move.to];
  if (move.from === "verifying" && move.to === "resolved") {
    return `Moved from ${from} to ${to} by the system: a later run executed its scenario and every attempt passed.`;
  }
  if (move.from === "verifying" && move.to === "in_fix") {
    return `Moved from ${from} back to ${to} by the system: a later run recorded a new occurrence.`;
  }
  if (move.from === "resolved" && move.to === "new") {
    return `Reopened as ${to} by the system: a new occurrence arrived after it was ${from}.`;
  }
  return `Moved from ${from} to ${to} by the system.`;
}

export function buildStatusUpdate(
  status: FindingStatus,
  knownGapReason: string | null = null,
): FindingUpdate {
  return knownGapReason === null ? { status } : { status, known_gap_reason: knownGapReason.trim() };
}

const duplicateIdSchema = z.guid();

export function readPossibleDuplicate(evidence: Readonly<Record<string, unknown>>): string | null {
  const parsed = duplicateIdSchema.safeParse(evidence.possible_duplicate_of);
  return parsed.success ? parsed.data : null;
}

export interface CodeReference {
  label: string;
  path: string;
  line: number;
}

const CODE_REFERENCE_PATTERN =
  /(?:^|[^\w./\\@-])((?:[\w.@-]+[\\/])*[\w@-][\w.@-]*\.[A-Za-z][A-Za-z0-9]{0,9}):(\d{1,6})(?:-\d{1,6})?(?!\w)/g;

export function extractCodeReferences(
  text: string,
  limit: number = MAX_CODE_REFERENCES,
): CodeReference[] {
  const found = new Map<string, CodeReference>();
  for (const match of text.matchAll(CODE_REFERENCE_PATTERN)) {
    const path = match[1];
    const line = match[2];
    if (path === undefined || line === undefined) {
      continue;
    }
    const label = `${path}:${line}`;
    if (!found.has(label)) {
      found.set(label, { label, path, line: Number(line) });
    }
    if (found.size >= limit) {
      break;
    }
  }
  return [...found.values()];
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export const structuredExplanationSchema = z.object({
  opinion: z.enum(["app_bug", "scenario_bug", "harness", "unknown"]),
  root_cause: z.string(),
  files: z.array(z.object({ path: z.string(), lines: z.string().nullish() })),
  commit: z.string().nullish(),
  fix_branch: z.string().nullish(),
  confidence: z.enum(["low", "medium", "high"]),
});

export function parseStructuredExplanation(value: unknown): ExplanationStructured | null {
  const parsed = structuredExplanationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
