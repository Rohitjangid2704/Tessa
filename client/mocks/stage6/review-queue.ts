import { cellKey } from "../stage2/expand";
import { stableId } from "../stage2/ids";
import type { LibraryContext } from "../stage2/library";
import { plusSeconds, renderScenarioYaml, type ScenarioStepDoc } from "../stage2/scenario-factory";
import type { ScenarioRecord } from "../stage2/types";
import type {
  Scenario,
  ScenarioDryRun,
  ScenarioIssue,
  ScenarioOrigin,
  ScenarioProvenance,
  VerdictStatus,
} from "@/lib/api/types";

const REVIEW_QUEUE_OFFSET_HOURS = 30;
const HALF_HOUR_SECONDS = 1800;
const HOUR_SECONDS = 3600;
const DRY_RUN_HOST_RUN = stableId("seed_run", "completed");

export const GENERATOR = {
  model: "claude-sonnet-5-5",
  effort: "medium",
  template_version: 2,
} as const satisfies NonNullable<ScenarioProvenance["generator"]>;

export const TICKET_URL = "https://tracker.example.test/GRACIE-142";

type ProvenanceDetails = Partial<
  Pick<
    ScenarioProvenance,
    | "cell_id"
    | "finding_id"
    | "ticket_url"
    | "prompt_issue_id"
    | "replay_id"
    | "generator"
    | "dry_runs"
  >
>;

interface ReviewSpec {
  key: string;
  title: string;
  featureId: string;
  family: string;
  role: string;
  interfaceId: string;
  origin: ScenarioOrigin;
  steps: ScenarioStepDoc[];
  warnings?: ScenarioIssue[];
  dryRuns?: readonly VerdictStatus[];
  generator?: ProvenanceDetails["generator"];
  promptIssue?: boolean;
  findingKey?: string;
  replayKey?: string;
}

const seededProvenance = new Map<string, ProvenanceDetails>();

function chat(label: string, ask: string, expect: Record<string, unknown> = {}): ScenarioStepDoc {
  return {
    label,
    adapter: "sse",
    ask,
    request: { method: "POST", path: "/api/v1/chat", body: { message: ask } },
    expect: { status: 200, events: { include: ["done"] }, ...expect },
  };
}

function http(
  label: string,
  method: string,
  path: string,
  expect: Record<string, unknown> = { status: 200 },
): ScenarioStepDoc {
  return { label, adapter: "http", request: { method, path }, expect };
}

const SPECS: ReviewSpec[] = [
  {
    key: "generated_close_issue_command",
    title: "Closing an issue works when the request is a plain command",
    featureId: "smart_log.write.close_issue",
    family: "smart-log",
    role: "housekeeping_lead",
    interfaceId: "chat_sse",
    origin: "generated",
    steps: [
      chat("Ask with a command", "Close issue 4412, the leaking tap in room 20003", {
        cards: { min_count: 1, include: [{ kind: "confirmation" }] },
      }),
    ],
    dryRuns: ["pass", "pass"],
    generator: GENERATOR,
  },
  {
    key: "generated_negative_login",
    title: "Staff login rejects an empty password",
    featureId: "access.auth.login_staff",
    family: "account-access",
    role: "guest",
    interfaceId: "rest_api",
    origin: "generated",
    steps: [http("Empty password", "POST", "/auth/login", { status: [400, 401, 422] })],
    warnings: [
      {
        code: "status_not_documented",
        pointer: "/steps/0/expect/status",
        line: null,
        column: null,
        message: "422 is not a documented status for this operation",
      },
    ],
    dryRuns: ["pass", "fail"],
    generator: { ...GENERATOR, effort: "low" },
  },
  {
    key: "generated_manager_occupancy",
    title: "A manager reads the weekly occupancy summary",
    featureId: "reports.read.occupancy_summary",
    family: "reports",
    role: "manager",
    interfaceId: "rest_api",
    origin: "generated",
    steps: [http("Weekly summary", "GET", "/reports/occupancy?range=week", { status: 200 })],
    dryRuns: [],
    generator: { ...GENERATOR, effort: "high", template_version: 1 },
  },
  {
    key: "authored_towel_flow",
    title: "A guest asks for a towel and tracks the request",
    featureId: "guest_requests.flow.request_and_track",
    family: "guest-requests",
    role: "guest",
    interfaceId: "browser",
    origin: "authored",
    steps: [
      {
        label: "Open the requests page",
        adapter: "browser",
        action: "goto",
        url: "/requests",
        expect: { dom_state: { url: "/requests" } },
      },
      {
        label: "Ask for a towel",
        adapter: "browser",
        action: "fill",
        target: { role: "textbox", name: "Message" },
        value: "I need a fresh towel in room 20003",
        expect: {},
      },
      {
        label: "Send the request",
        adapter: "browser",
        action: "click",
        target: { role: "button", name: "Send" },
        expect: { dom_state: { text_contains: ["towel"] } },
      },
    ],
    dryRuns: ["pass", "pass"],
    promptIssue: true,
  },
  {
    key: "promoted_escalation_twice",
    title: "The escalation sweep marks a request exactly once",
    featureId: "streaming.job.escalation_sweep",
    family: "streaming-jobs",
    role: "admin",
    interfaceId: "rest_api",
    origin: "promoted_finding",
    steps: [http("Run the sweep", "POST", "/jobs/escalation-sweep", { status: 202 })],
    dryRuns: ["fail", "fail"],
    findingKey: "escalation-twice",
  },
  {
    key: "replay_late_checkout",
    title: "Replayed: a guest asks about late checkout",
    featureId: "streaming.stream.chat_reply",
    family: "streaming-jobs",
    role: "guest",
    interfaceId: "chat_sse",
    origin: "replay",
    steps: [chat("Ask about late checkout", "Can I check out at 2 pm tomorrow?")],
    dryRuns: ["pass", "flaky"],
    replayKey: "traffic-2026-09-30",
  },
];

function dryRunsOf(scenarioId: string, verdicts: readonly VerdictStatus[]): ScenarioDryRun[] {
  return verdicts.map((status, index): ScenarioDryRun => ({
    run_id: DRY_RUN_HOST_RUN,
    run_scenario_id: stableId("dry_run_scenario", scenarioId, index),
    verdict: {
      status,
      tier: "code",
      confidence: null,
      reason: status === "fail" ? "The expectation on the response status did not hold" : null,
      reason_code: null,
      skip_reason: null,
    },
  }));
}

function reviewId(targetId: string, key: string): string {
  return stableId("scenario_review", targetId, key);
}

function toScenario(spec: ReviewSpec, context: LibraryContext, index: number): Scenario {
  const createdAt = plusSeconds(
    context.baseIso,
    REVIEW_QUEUE_OFFSET_HOURS * HOUR_SECONDS + index * HALF_HOUR_SECONDS,
  );
  const doc = {
    schema_version: 1,
    title: spec.title,
    feature_id: spec.featureId,
    family: spec.family,
    role: spec.role,
    interface_id: spec.interfaceId,
    timeout_seconds: 120,
    cell: { role: spec.role, interface_id: spec.interfaceId },
    synthetic: false,
    steps: spec.steps,
  };
  const id = reviewId(context.targetId, spec.key);
  const cellId = stableId("cell", context.targetId, cellKey(spec.featureId, spec.role, spec.interfaceId));
  seededProvenance.set(id, {
    cell_id: cellId,
    generator: spec.generator ?? null,
    dry_runs: dryRunsOf(id, spec.dryRuns ?? []),
    prompt_issue_id: spec.promptIssue ? stableId("prompt_issue", "author", spec.key) : null,
    finding_id: spec.findingKey ? stableId("finding", spec.findingKey) : null,
    ticket_url: spec.findingKey ? TICKET_URL : null,
    replay_id: spec.replayKey ? stableId("replay", spec.replayKey) : null,
  });
  return {
    id,
    target_id: context.targetId,
    bundle_id: context.bundleId,
    feature_id: spec.featureId,
    cell_id: cellId,
    title: spec.title,
    family: spec.family,
    origin: spec.origin,
    status: "in_review",
    version: 1,
    yaml: renderScenarioYaml(doc),
    parsed: JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
    synthetic: false,
    validation: { valid: true, errors: [], warnings: spec.warnings ?? [] },
    provenance: { source: spec.origin, bundle_version: context.bundleVersion },
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export function buildReviewQueueScenarios(context: LibraryContext): ScenarioRecord[] {
  return SPECS.map((spec, index) => ({ scenario: toScenario(spec, context, index), cellKey: null }));
}

export function seededProvenanceOf(scenarioId: string): ProvenanceDetails | undefined {
  return seededProvenance.get(scenarioId);
}

export const REVIEW_QUEUE_KEYS: readonly string[] = SPECS.map((spec) => spec.key);

export function reviewScenarioId(targetId: string, key: string): string {
  return reviewId(targetId, key);
}
