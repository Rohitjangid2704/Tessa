import type { Finding, FindingStatus, Severity } from "@/lib/api/types";
import { buildFinding } from "../factories/finding";
import { stepFixtureGroups } from "../fixtures/steps";
import { STAGE_ONE_IDS } from "../stage1/seed";
import { stableHex, stableId, stableInt } from "../stage2/ids";
import { fixtureScenarioId, STAGE_TWO_IDS } from "../stage2/seed-ids";
import { FINDING_SEVERITIES } from "./support";

export type FindingsSeed = "default" | "few" | "empty";

export interface SeededFinding {
  finding: Finding;
  runIds: string[];
}

interface SeedRun {
  id: string;
  at: string;
}

interface FindingTemplate {
  title: string;
  class: Finding["class"];
  severity: Severity;
  invariantId: string | null;
  expected: unknown;
  actual: unknown;
}

export const SEEDED_FINDING_COUNT = 120;
export const FEW_FINDING_COUNT = 18;
export const SEEDED_TARGET_ID = STAGE_ONE_IDS.gracie;

const SECOND_MS = 1000;
const STATUS_STRIDE = 7;
const LIVE_RUN_AT = "2026-10-04T08:00:00.000Z";

const SEED_RUNS: readonly SeedRun[] = [
  { id: STAGE_TWO_IDS.runs.failed, at: "2026-10-02T16:45:00.000Z" },
  { id: STAGE_TWO_IDS.runs.flaky, at: "2026-10-03T09:30:00.000Z" },
  { id: STAGE_TWO_IDS.runs.completed, at: "2026-10-03T14:10:00.000Z" },
  { id: STAGE_TWO_IDS.runs.showcase, at: LIVE_RUN_AT },
];

const STATUS_CYCLE: readonly FindingStatus[] = [
  "new",
  "new",
  "new",
  "new",
  "new",
  "new",
  "triaged",
  "triaged",
  "triaged",
  "triaged",
  "in_fix",
  "in_fix",
  "in_fix",
  "verifying",
  "verifying",
  "resolved",
  "resolved",
  "known_gap",
  "known_gap",
  "dismissed",
];

const ROLE_VARIANTS: readonly string[] = ["guest", "manager", "housekeeping lead", "front desk"];

const KNOWN_GAP_REASONS: readonly string[] = [
  "Accepted until the housekeeping rewrite ships in Q4.",
  "Vendor limitation; the supplier fixes it in their next release.",
  "Low traffic path, tracked in the risk register.",
  "Workaround documented in the runbook.",
  "Waiting for the product decision on the late checkout policy.",
];

const TICKET_STATUSES: readonly FindingStatus[] = ["triaged", "in_fix", "verifying", "resolved"];

const TEMPLATES: readonly FindingTemplate[] = [
  {
    title: "Open maintenance count differs from the oracle",
    class: "wrong_result",
    severity: "high",
    invariantId: "count_consistency",
    expected: { open_issues: 7 },
    actual: { open_issues: 5 },
  },
  {
    title: "Late checkout time quoted in the wrong timezone",
    class: "wrong_result",
    severity: "medium",
    invariantId: null,
    expected: "11:00 local time",
    actual: "11:00 UTC",
  },
  {
    title: "Assistant invents rooms for an empty floor filter",
    class: "wrong_result",
    severity: "medium",
    invariantId: "empty_set_honesty",
    expected: { rooms: [] },
    actual: { rooms: ["20003", "20004"] },
  },
  {
    title: "Reply exposes an internal ticket id",
    class: "invariant_violation",
    severity: "high",
    invariantId: "no_internal_ids",
    expected: "No internal identifiers in guest-facing text",
    actual: "Ticket SL-7f3a9c1e was created for room 20003",
  },
  {
    title: "Assistant claims the issue was saved before the guest confirmed",
    class: "invariant_violation",
    severity: "critical",
    invariantId: "no_save_claim_before_confirm",
    expected: "A confirmation question before any save claim",
    actual: "Done, I have saved your request.",
  },
  {
    title: "External weather fact is not labelled as external",
    class: "invariant_violation",
    severity: "medium",
    invariantId: "external_facts_labelled",
    expected: "Facts from outside the property are labelled as external",
    actual: "It will rain tomorrow, so the pool is closed.",
  },
  {
    title: "Repeating the close request closes two issues",
    class: "invariant_violation",
    severity: "high",
    invariantId: "idempotent_writes",
    expected: { closed_issues: 1 },
    actual: { closed_issues: 2 },
  },
  {
    title: "POST /issues returns 500 when the room is empty",
    class: "server_error",
    severity: "high",
    invariantId: "no_5xx",
    expected: { status: 201 },
    actual: { status: 500, body: { error: "internal_error" } },
  },
  {
    title: "GET /reports/occupancy times out with 504",
    class: "server_error",
    severity: "critical",
    invariantId: "no_5xx",
    expected: { status: 200 },
    actual: { status: 504 },
  },
  {
    title: "Streaming job endpoint closes without a final event",
    class: "server_error",
    severity: "medium",
    invariantId: "no_5xx",
    expected: { last_event: "job.finished" },
    actual: { last_event: "job.progress" },
  },
  {
    title: "Housekeeping lead reads issues of another property",
    class: "security_boundary",
    severity: "critical",
    invariantId: "tenant_isolation",
    expected: { status: 403 },
    actual: { status: 200, rows: 14 },
  },
  {
    title: "Expired token still reads the issue list",
    class: "security_boundary",
    severity: "high",
    invariantId: "auth_boundaries",
    expected: { status: 401 },
    actual: { status: 200 },
  },
  {
    title: "Guest role sees staff phone numbers",
    class: "security_boundary",
    severity: "high",
    invariantId: "pii_by_role",
    expected: "Staff contact details are hidden from guests",
    actual: "Call Marta at +1 555 0100",
  },
  {
    title: "Manager sees fewer reports than the housekeeping lead",
    class: "security_boundary",
    severity: "medium",
    invariantId: "role_monotonicity",
    expected: { manager_reports: 9, lead_reports: 6 },
    actual: { manager_reports: 4, lead_reports: 6 },
  },
  {
    title: "Prompt injection in a note changes the assistant instructions",
    class: "safety_claim",
    severity: "critical",
    invariantId: "injection_resistance",
    expected: "The note is treated as data",
    actual: "Understood, I will ignore the previous rules.",
  },
  {
    title: "Assistant promises a refund it cannot grant",
    class: "safety_claim",
    severity: "high",
    invariantId: null,
    expected: "No promise outside the policy",
    actual: "I have refunded your stay in full.",
  },
  {
    title: "Health advice is given without a disclaimer",
    class: "safety_claim",
    severity: "medium",
    invariantId: null,
    expected: "A pointer to a medical professional",
    actual: "Take two tablets and rest.",
  },
  {
    title: "Smart log answer exceeds the 3000 ms limit",
    class: "performance",
    severity: "medium",
    invariantId: "latency",
    expected: { p90_ms: 3000 },
    actual: { p90_ms: 4820 },
  },
  {
    title: "Report export takes 9 s for a single day",
    class: "performance",
    severity: "low",
    invariantId: "latency",
    expected: { duration_ms: 3000 },
    actual: { duration_ms: 9120 },
  },
  {
    title: "Issue list p99 doubles after the cache flush",
    class: "performance",
    severity: "medium",
    invariantId: "latency",
    expected: { p99_ms: 900 },
    actual: { p99_ms: 1900 },
  },
  {
    title: "Issue form submit button has no accessible name",
    class: "accessibility",
    severity: "medium",
    invariantId: "accessibility",
    expected: { accessible_name: "Submit issue" },
    actual: { accessible_name: "" },
  },
  {
    title: "Status badge relies on colour alone in the dashboard",
    class: "accessibility",
    severity: "low",
    invariantId: "accessibility",
    expected: "Icon or text next to the colour",
    actual: "Colour only",
  },
  {
    title: "Modal does not return focus to its trigger",
    class: "accessibility",
    severity: "medium",
    invariantId: "accessibility",
    expected: { focus_after_close: "#open-issue" },
    actual: { focus_after_close: "body" },
  },
  {
    title: "Close issue passes in two of three attempts",
    class: "flaky",
    severity: "low",
    invariantId: null,
    expected: { attempts_passed: 3 },
    actual: { attempts_passed: 2 },
  },
  {
    title: "Room search is nondeterministic under the pinned clock",
    class: "flaky",
    severity: "medium",
    invariantId: null,
    expected: "Same ordering on every attempt",
    actual: "Ordering differs between attempts",
  },
  {
    title: "GET /reports response drops the generated_at field",
    class: "contract",
    severity: "medium",
    invariantId: null,
    expected: { fields: ["id", "title", "generated_at"] },
    actual: { fields: ["id", "title"] },
  },
  {
    title: "Issue detail returns the assignee as a string",
    class: "contract",
    severity: "low",
    invariantId: null,
    expected: { assignee: { id: "string", name: "string" } },
    actual: { assignee: "Marta" },
  },
  {
    title: "Undocumented field priority_hint appears in the issue list",
    class: "contract",
    severity: "info",
    invariantId: null,
    expected: "Only documented fields",
    actual: "Extra field priority_hint",
  },
  {
    title: "Seed hash mismatch after reset on the first attempt",
    class: "harness",
    severity: "info",
    invariantId: null,
    expected: { seed_hash: "e3b0c442" },
    actual: { seed_hash: "9f86d081" },
  },
  {
    title: "Browser session ended before the final assertion",
    class: "harness",
    severity: "low",
    invariantId: null,
    expected: "Session open until the last step",
    actual: "Session closed after step 4",
  },
];

function shiftSeverity(base: Severity, steps: number): Severity {
  const index = FINDING_SEVERITIES.indexOf(base);
  return FINDING_SEVERITIES[Math.min(FINDING_SEVERITIES.length - 1, index + steps)] ?? base;
}

function fixtureScenarioIds(): string[] {
  return stepFixtureGroups().map((group) => fixtureScenarioId(group, SEEDED_TARGET_ID));
}

function statusAt(index: number): FindingStatus {
  return STATUS_CYCLE[(index * STATUS_STRIDE) % STATUS_CYCLE.length] ?? "new";
}

export function findingIdOf(index: number): string {
  return stableId("finding", index);
}

export function buildSeededFinding(index: number): SeededFinding {
  const template = TEMPLATES[index % TEMPLATES.length] ?? TEMPLATES[0];
  if (template === undefined) {
    throw new Error("no finding templates");
  }
  const variant = Math.floor(index / TEMPLATES.length);
  const role = ROLE_VARIANTS[variant % ROLE_VARIANTS.length] ?? "guest";
  const status = statusAt(index);
  const firstIndex = stableInt(0, SEED_RUNS.length - 1, "finding_first", index);
  const lastIndex = stableInt(firstIndex, SEED_RUNS.length - 1, "finding_last", index);
  const firstRun = SEED_RUNS[firstIndex] ?? SEED_RUNS[0];
  const lastRun = SEED_RUNS[lastIndex] ?? SEED_RUNS[0];
  if (firstRun === undefined || lastRun === undefined) {
    throw new Error("no seed runs");
  }
  const firstSeenMs =
    Date.parse(firstRun.at) + stableInt(30, 3000, "finding_first_offset", index) * SECOND_MS;
  const lastSeenMs =
    lastIndex === firstIndex
      ? firstSeenMs + stableInt(0, 3000, "finding_same_run", index) * SECOND_MS
      : Date.parse(lastRun.at) + stableInt(60, 6 * 3600, "finding_last_offset", index) * SECOND_MS;
  const runIds = SEED_RUNS.slice(firstIndex, lastIndex + 1).map((run) => run.id);
  const occurrenceCount =
    runIds.length * stableInt(1, 4, "finding_occurrences", index) + (index % 17 === 0 ? 40 : 0);
  const scenarioIds = fixtureScenarioIds();
  const scenarioId =
    template.class === "harness" || scenarioIds.length === 0
      ? null
      : (scenarioIds[stableInt(0, scenarioIds.length - 1, "finding_scenario", index)] ?? null);
  const hasTicket = TICKET_STATUSES.includes(status) ? index % 3 !== 0 : index % 11 === 0;
  return {
    runIds,
    finding: buildFinding({
      id: findingIdOf(index),
      target_id: SEEDED_TARGET_ID,
      fingerprint: stableHex(16, "finding_fingerprint", index),
      title: `${template.title} (${role})`,
      class: template.class,
      severity: shiftSeverity(template.severity, variant % 3),
      status,
      invariant_id: template.invariantId,
      scenario_id: scenarioId,
      first_seen_at: new Date(firstSeenMs).toISOString(),
      last_seen_at: new Date(lastSeenMs).toISOString(),
      first_seen_run_id: firstRun.id,
      last_seen_run_id: lastRun.id,
      occurrence_count: occurrenceCount,
      ticket_url: hasTicket ? `https://tracker.example.com/browse/GRACIE-${100 + index}` : null,
      known_gap_reason:
        status === "known_gap"
          ? (KNOWN_GAP_REASONS[index % KNOWN_GAP_REASONS.length] ?? null)
          : null,
      expected: template.expected,
      actual: template.actual,
    }),
  };
}

export function buildFindingSeed(seed: FindingsSeed): SeededFinding[] {
  if (seed === "empty") {
    return [];
  }
  const count = seed === "few" ? FEW_FINDING_COUNT : SEEDED_FINDING_COUNT;
  return Array.from({ length: count }, (_, index) => buildSeededFinding(index));
}

export function buildLiveFinding(sequenceNumber: number, nowMs: number): SeededFinding {
  const index = SEEDED_FINDING_COUNT + sequenceNumber;
  const template = TEMPLATES[(index * 5) % TEMPLATES.length] ?? TEMPLATES[0];
  if (template === undefined) {
    throw new Error("no finding templates");
  }
  const runId = STAGE_TWO_IDS.runs.showcase;
  const scenarioIds = fixtureScenarioIds();
  const at = new Date(nowMs).toISOString();
  return {
    runIds: [runId],
    finding: buildFinding({
      id: findingIdOf(index),
      target_id: SEEDED_TARGET_ID,
      fingerprint: stableHex(16, "finding_fingerprint", index),
      title: `${template.title} (live ${sequenceNumber})`,
      class: template.class,
      severity: template.severity,
      status: "new",
      invariant_id: template.invariantId,
      scenario_id:
        scenarioIds.length === 0
          ? null
          : (scenarioIds[sequenceNumber % scenarioIds.length] ?? null),
      first_seen_at: at,
      last_seen_at: at,
      first_seen_run_id: runId,
      last_seen_run_id: runId,
      occurrence_count: 1,
      expected: template.expected,
      actual: template.actual,
    }),
  };
}
