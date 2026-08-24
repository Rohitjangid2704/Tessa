import { z } from "zod";
import type { InterimSchemas, Schemas } from "@/lib/api/types";

const identifierSchema = z.guid();
const timestampSchema = z.iso.datetime({ offset: true });
const countSchema = z.number().int().min(0);
const measureSchema = z.number().min(0);

export const runStatusSchema = z.enum([
  "queued",
  "planning",
  "seeding",
  "running",
  "canceling",
  "completed",
  "failed",
  "canceled",
  "budget_exceeded",
]) satisfies z.ZodType<Schemas["RunStatus"]>;

export const runKindSchema = z.enum([
  "suite",
  "seed",
  "generate",
  "explore",
  "simulate",
  "redteam",
  "replay",
  "mutation",
  "contract",
  "import",
  "calibration",
  "hello",
]) satisfies z.ZodType<Schemas["RunKind"]>;

export const runTriggerSchema = z.enum(["manual", "schedule", "api"]) satisfies z.ZodType<
  Schemas["RunTrigger"]
>;

export const feedNameSchema = z.enum(["runs", "home", "coverage", "findings"]) satisfies z.ZodType<
  Schemas["FeedName"]
>;

export const tileQualitySchema = z.object({
  max_fps: z.number(),
  quality: z.number(),
  max_width: z.number(),
}) satisfies z.ZodType<Schemas["TileQuality"]>;

export const streamLimitsSchema = z.object({
  max_tiles: z.number(),
  grid: tileQualitySchema,
  focus: tileQualitySchema,
}) satisfies z.ZodType<Schemas["StreamLimits"]>;

export const runCountersSchema = z.object({
  scenarios_total: countSchema,
  scenarios_done: countSchema,
  pass: countSchema,
  fail: countSchema,
  flaky: countSchema,
  uncertain: countSchema,
  skipped: countSchema,
  steps_recorded: countSchema,
}) satisfies z.ZodType<Schemas["RunCounters"]>;

export const adapterKindSchema = z.enum([
  "http",
  "sse",
  "websocket",
  "graphql",
  "browser",
  "webhook",
  "cli",
]) satisfies z.ZodType<Schemas["AdapterKind"]>;

export const verdictStatusSchema = z.enum([
  "pass",
  "fail",
  "flaky",
  "uncertain",
  "skipped",
]) satisfies z.ZodType<Schemas["VerdictStatus"]>;

export const verdictTierSchema = z.enum(["code", "laya", "judge", "human"]) satisfies z.ZodType<
  Schemas["VerdictTier"]
>;

export const skipReasonSchema = z.enum([
  "service_down",
  "hook_missing",
  "precondition_failed",
  "env_missing",
  "role_unavailable",
  "budget_exceeded",
  "canceled",
  "production_blocked",
  "flag_disabled",
  "quarantined",
  "seed_mismatch",
  "adapter_unsupported",
]) satisfies z.ZodType<Schemas["SkipReason"]>;

export const runScenarioStatusSchema = z.enum([
  "queued",
  "running",
  "finished",
  "skipped",
  "errored",
  "canceled",
]) satisfies z.ZodType<Schemas["RunScenarioStatus"]>;

export const verdictSchema = z.object({
  status: verdictStatusSchema,
  tier: verdictTierSchema,
  confidence: z.number().min(0).max(1).nullable(),
  reason_code: z.string().nullable(),
  reason: z.string().nullable(),
  skip_reason: skipReasonSchema.nullable(),
}) satisfies z.ZodType<Schemas["Verdict"]>;

export const budgetStateSchema = z.object({
  max_usd: measureSchema,
  spent_usd: measureSchema,
  max_minutes: countSchema,
  elapsed_ms: measureSchema,
}) satisfies z.ZodType<Schemas["BudgetState"]>;

export const streamHelloPayloadSchema = z.object({
  run_id: z.string().nullable(),
  head_seq: countSchema.nullable(),
  resumed_from: countSchema.nullable(),
  heartbeat_seconds: z.number(),
  limits: streamLimitsSchema.nullable(),
  feed: feedNameSchema.nullable(),
}) satisfies z.ZodType<Schemas["StreamHelloPayload"]>;

export const streamReplayEndPayloadSchema = z.object({
  through_seq: countSchema,
}) satisfies z.ZodType<Schemas["StreamReplayEndPayload"]>;

export const streamResyncRequiredPayloadSchema = z.object({
  reason: z.enum(["gap_too_large", "retention"]),
  min_seq: countSchema,
}) satisfies z.ZodType<Schemas["StreamResyncRequiredPayload"]>;

export const streamHeartbeatPayloadSchema = z.record(z.string(), z.never());

export const streamClosingPayloadSchema = z.object({
  reason: z.enum(["max_age", "shutdown", "slow_consumer"]),
}) satisfies z.ZodType<Schemas["StreamClosingPayload"]>;

export const streamErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
}) satisfies z.ZodType<Schemas["StreamErrorPayload"]>;

export const helloTickPayloadSchema = z.object({
  n: countSchema,
  total: countSchema,
  message: z.string(),
}) satisfies z.ZodType<Schemas["HelloTickPayload"]>;

export const helloLayaPayloadSchema = z.object({
  ok: z.boolean(),
  latency_ms: z.number(),
  status_code: z.number().int().nullable(),
  error: z.string().nullable(),
}) satisfies z.ZodType<Schemas["HelloLayaPayload"]>;

export const runCreatedPayloadSchema = z.object({
  kind: runKindSchema,
  target_id: z.string().nullable(),
  plan_id: z.string().nullable(),
  trigger: runTriggerSchema,
  created_by: z.string(),
  status: runStatusSchema,
}) satisfies z.ZodType<Schemas["RunCreatedPayload"]>;

export const runStatusChangedPayloadSchema = z.object({
  status: runStatusSchema,
  previous: runStatusSchema,
  reason: z.string().nullable(),
}) satisfies z.ZodType<Schemas["RunStatusChangedPayload"]>;

export const runFinishedPayloadSchema = z.object({
  status: runStatusSchema,
  counters: runCountersSchema,
  spent_usd: z.number(),
  duration_ms: z.number(),
}) satisfies z.ZodType<Schemas["RunFinishedPayload"]>;

export const runProgressPayloadSchema = runCountersSchema;

export const budgetUpdatedPayloadSchema = budgetStateSchema;

export const budgetExhaustedPayloadSchema = z.object({
  dimension: z.enum(["usd", "minutes"]),
  limit: measureSchema,
  actual: measureSchema,
}) satisfies z.ZodType<Schemas["BudgetExhaustedPayload"]>;

export const scenarioQueuedPayloadSchema = z.object({
  run_scenario_id: identifierSchema,
  scenario_id: identifierSchema,
  title: z.string(),
  role: z.string(),
  interface_id: z.string(),
  attempts_total: countSchema,
}) satisfies z.ZodType<Schemas["ScenarioQueuedPayload"]>;

export const scenarioStartedPayloadSchema = z.object({
  run_scenario_id: identifierSchema,
  attempt: countSchema,
}) satisfies z.ZodType<Schemas["ScenarioStartedPayload"]>;

export const scenarioVerdictPayloadSchema = z.object({
  run_scenario_id: identifierSchema,
  attempt: countSchema,
  verdict: verdictSchema,
}) satisfies z.ZodType<Schemas["ScenarioVerdictPayload"]>;

export const scenarioFinishedPayloadSchema = z.object({
  run_scenario_id: identifierSchema,
  status: runScenarioStatusSchema,
  verdict: verdictSchema.nullable(),
  attempts: z.object({ passed: countSchema, failed: countSchema, total: countSchema }),
  duration_ms: measureSchema,
}) satisfies z.ZodType<Schemas["ScenarioFinishedPayload"]>;

export const stepRecordedPayloadSchema = z.object({
  step_id: identifierSchema,
  run_scenario_id: identifierSchema,
  attempt: countSchema,
  index: countSchema,
  adapter: adapterKindSchema,
  label: z.string(),
  ok: z.boolean().nullable(),
  latency_ms: measureSchema,
  cost_usd: measureSchema,
  tier0_failure_count: countSchema,
  screenshot_count: countSchema,
}) satisfies z.ZodType<Schemas["StepRecordedPayload"]>;

export const browserSessionStartedPayloadSchema = z.object({
  browser_session_id: identifierSchema,
  run_scenario_id: identifierSchema,
  attempt: countSchema,
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  scenario_title: z.string(),
  started_at: timestampSchema,
}) satisfies z.ZodType<Schemas["BrowserSessionStartedPayload"]>;

export const browserSessionEndedPayloadSchema = z.object({
  browser_session_id: identifierSchema,
  run_scenario_id: identifierSchema,
  has_recording: z.boolean(),
  has_trace: z.boolean(),
  ended_at: timestampSchema,
}) satisfies z.ZodType<Schemas["BrowserSessionEndedPayload"]>;

export const seedProgressPayloadSchema = z.object({
  phase: z.enum(["reset", "hash", "assert"]),
  status: z.enum(["started", "ok", "failed"]),
  observed_hash: z.string().nullable(),
  expected_hash: z.string().nullable(),
}) satisfies z.ZodType<Schemas["SeedProgressPayload"]>;

export const stepGradedPayloadSchema = z.object({
  step_id: identifierSchema,
  run_scenario_id: identifierSchema,
  verdict: verdictSchema,
  escalated_to: verdictTierSchema.nullable(),
}) satisfies z.ZodType<Schemas["StepGradedPayload"]>;

export const tileFramePayloadSchema = z.object({
  browser_session_id: identifierSchema,
  frame_seq: countSchema,
  mime: z.literal("image/jpeg"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  data_b64: z.string().min(1),
  page_url: z.string().nullable().default(null),
  captured_at: timestampSchema,
}) satisfies z.ZodType<Schemas["TileFramePayload"]>;

export const severitySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
  "info",
]) satisfies z.ZodType<InterimSchemas["Severity"]>;

export const findingStatusSchema = z.enum([
  "new",
  "triaged",
  "in_fix",
  "verifying",
  "resolved",
  "known_gap",
  "dismissed",
]) satisfies z.ZodType<InterimSchemas["FindingStatus"]>;

export const findingClassSchema = z.enum([
  "wrong_result",
  "invariant_violation",
  "server_error",
  "security_boundary",
  "safety_claim",
  "performance",
  "accessibility",
  "flaky",
  "contract",
  "harness",
]) satisfies z.ZodType<InterimSchemas["FindingClass"]>;

export const invariantPackSchema = z.enum(["generic", "llm_app", "target"]) satisfies z.ZodType<
  Schemas["InvariantPack"]
>;

export const invariantResultPayloadSchema = z.object({
  invariant_id: z.string(),
  pack: invariantPackSchema,
  run_scenario_id: identifierSchema.nullable(),
  attempt: countSchema.nullable(),
  status: verdictStatusSchema,
  tier: verdictTierSchema,
  message: z.string(),
  skip_reason: skipReasonSchema.nullable(),
}) satisfies z.ZodType<InterimSchemas["InvariantResultPayload"]>;

export const findingCreatedPayloadSchema = z.object({
  finding_id: identifierSchema,
  title: z.string(),
  class: findingClassSchema,
  severity: severitySchema,
  status: findingStatusSchema,
  fingerprint: z.string(),
  is_new: z.boolean(),
  scenario_id: identifierSchema.nullable(),
}) satisfies z.ZodType<InterimSchemas["FindingCreatedPayload"]>;

export const findingChangeSchema = z.object({
  from: z.unknown(),
  to: z.unknown(),
}) satisfies z.ZodType<InterimSchemas["FindingChange"]>;

export const findingUpdatedPayloadSchema = z.object({
  finding_id: identifierSchema,
  changes: z.record(z.string(), findingChangeSchema),
}) satisfies z.ZodType<InterimSchemas["FindingUpdatedPayload"]>;

export const findingOccurrenceAddedPayloadSchema = z.object({
  finding_id: identifierSchema,
  run_id: identifierSchema,
  occurrence_count: countSchema,
}) satisfies z.ZodType<InterimSchemas["FindingOccurrenceAddedPayload"]>;

export const scenarioStatusSchema = z.enum([
  "draft",
  "validating",
  "invalid",
  "in_review",
  "accepted",
  "rejected",
  "quarantined",
  "retired",
]) satisfies z.ZodType<Schemas["ScenarioStatus"]>;

export const coverageUpdateReasonSchema = z.enum([
  "generated",
  "run",
  "review",
]) satisfies z.ZodType<InterimSchemas["CoverageUpdateReason"]>;

export const scenarioChangedPayloadSchema = z.object({
  scenario_id: identifierSchema,
  status: scenarioStatusSchema,
  cell_id: identifierSchema.nullable(),
}) satisfies z.ZodType<InterimSchemas["ScenarioChangedPayload"]>;

export const coverageUpdatedPayloadSchema = z.object({
  target_id: identifierSchema,
  plan_id: identifierSchema.nullable(),
  cell_ids: z.array(identifierSchema),
  reason: coverageUpdateReasonSchema,
}) satisfies z.ZodType<InterimSchemas["CoverageUpdatedPayload"]>;

export const generationProgressPayloadSchema = z.object({
  cells_total: countSchema,
  cells_done: countSchema,
  scenarios_created: countSchema,
  scenarios_invalid: countSchema,
}) satisfies z.ZodType<InterimSchemas["GenerationProgressPayload"]>;

export const exploreActionKindSchema = z.enum([
  "navigate",
  "click",
  "type",
  "read",
  "finish",
]) satisfies z.ZodType<InterimSchemas["ExploreActionKind"]>;

export const simSpeakerSchema = z.enum(["persona", "target"]) satisfies z.ZodType<
  InterimSchemas["SimSpeaker"]
>;

export const attackOutcomeSchema = z.enum([
  "blocked",
  "breached",
  "inconclusive",
]) satisfies z.ZodType<InterimSchemas["AttackOutcome"]>;

export const simChecksSchema = z.object({
  end_state: verdictStatusSchema,
  calls: verdictStatusSchema,
  invariants: verdictStatusSchema,
  goal: verdictStatusSchema,
  dialogue: verdictStatusSchema,
}) satisfies z.ZodType<InterimSchemas["SimChecks"]>;

export const exploreActionPayloadSchema = z.object({
  index: countSchema,
  action: exploreActionKindSchema,
  target: z.string().nullable(),
  text: z.string().nullable(),
  url: z.string().nullable(),
  rationale: z.string(),
}) satisfies z.ZodType<InterimSchemas["ExploreActionPayload"]>;

export const exploreCandidatePayloadSchema = z.object({
  candidate_id: identifierSchema,
  description: z.string(),
  from_index: countSchema,
  to_index: countSchema,
}) satisfies z.ZodType<InterimSchemas["ExploreCandidatePayload"]>;

export const exploreVerifiedPayloadSchema = z.object({
  candidate_id: identifierSchema,
  verified: z.boolean(),
  replay_run_scenario_id: identifierSchema.nullable(),
  finding_id: identifierSchema.nullable(),
}) satisfies z.ZodType<InterimSchemas["ExploreVerifiedPayload"]>;

export const simTurnPayloadSchema = z.object({
  sim_session_id: identifierSchema,
  turn: countSchema,
  speaker: simSpeakerSchema,
  text_preview: z.string(),
}) satisfies z.ZodType<InterimSchemas["SimTurnPayload"]>;

export const simCheckedPayloadSchema = z.object({
  sim_session_id: identifierSchema,
  checks: simChecksSchema,
  verdict: verdictSchema,
}) satisfies z.ZodType<InterimSchemas["SimCheckedPayload"]>;

export const redteamRoundStartedPayloadSchema = z.object({
  round_id: identifierSchema,
  index: countSchema,
  family: z.string(),
}) satisfies z.ZodType<InterimSchemas["RedteamRoundStartedPayload"]>;

export const redteamAttackPayloadSchema = z.object({
  attack_id: identifierSchema,
  round_id: identifierSchema,
  family: z.string(),
  outcome: attackOutcomeSchema,
}) satisfies z.ZodType<InterimSchemas["RedteamAttackPayload"]>;

export const redteamRoundFinishedPayloadSchema = z.object({
  round_id: identifierSchema,
  index: countSchema,
  attacks: countSchema,
  candidates: countSchema,
  dry: z.boolean(),
}) satisfies z.ZodType<InterimSchemas["RedteamRoundFinishedPayload"]>;

export const replayProgressPayloadSchema = z.object({
  replay_id: identifierSchema,
  records_total: countSchema,
  cases_created: countSchema,
  cases_rejected: countSchema,
}) satisfies z.ZodType<InterimSchemas["ReplayProgressPayload"]>;

export const runStopRequestedPayloadSchema = z.object({
  requested_by: identifierSchema,
}) satisfies z.ZodType<InterimSchemas["RunStopRequestedPayload"]>;

export const mutationOutcomeSchema = z.enum([
  "killed",
  "survived",
  "errored",
  "skipped",
]) satisfies z.ZodType<InterimSchemas["MutationOutcome"]>;

export const notificationKindSchema = z.enum([
  "run_finished",
  "nightly_summary",
  "finding_regression",
  "budget_exceeded",
  "mutant_survived",
  "schedule_failed",
]) satisfies z.ZodType<InterimSchemas["NotificationKind"]>;

export const mutationOutcomePayloadSchema = z.object({
  mutation_run_id: identifierSchema,
  invariant_id: z.string(),
  outcome: mutationOutcomeSchema,
  caught_by: z.array(identifierSchema),
}) satisfies z.ZodType<InterimSchemas["MutationOutcomePayload"]>;

export const notificationCreatedPayloadSchema = z.object({
  notification_id: identifierSchema,
  kind: notificationKindSchema,
  severity: severitySchema,
  title: z.string(),
  link: z.string(),
}) satisfies z.ZodType<InterimSchemas["NotificationCreatedPayload"]>;

export const dashboardInvalidatePayloadSchema = z.record(z.string(), z.never());

export const contractProgressPayloadSchema = z.object({
  contract_check_id: identifierSchema,
  items_total: countSchema,
  items_done: countSchema,
  breaking: countSchema,
}) satisfies z.ZodType<InterimSchemas["ContractProgressPayload"]>;

export const proposalItemStatusSchema = z.enum([
  "proposed",
  "selected",
  "declined",
  "authored",
  "covered",
]) satisfies z.ZodType<InterimSchemas["ProposalItemStatus"]>;

export const proposalUpdatedPayloadSchema = z.object({
  target_id: identifierSchema,
  proposal_id: identifierSchema,
  item_id: identifierSchema.nullable(),
  status: proposalItemStatusSchema.nullable(),
}) satisfies z.ZodType<InterimSchemas["ProposalUpdatedPayload"]>;

export const agentSessionChangedPayloadSchema = z.object({
  agent_session_id: identifierSchema,
  user_id: identifierSchema,
  target_id: identifierSchema.nullable(),
  active: z.boolean(),
}) satisfies z.ZodType<InterimSchemas["AgentSessionChangedPayload"]>;

export type EventStage = 0 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 11;

export type EventPersistence = "persisted" | "ephemeral";

export interface EventDefinition {
  stage: EventStage;
  persistence: EventPersistence;
  payload: z.ZodType;
}

export const EVENT_REGISTRY = {
  "stream.hello": {
    stage: 0,
    persistence: "ephemeral",
    payload: streamHelloPayloadSchema,
  },
  "stream.replay_end": {
    stage: 0,
    persistence: "ephemeral",
    payload: streamReplayEndPayloadSchema,
  },
  "stream.resync_required": {
    stage: 0,
    persistence: "ephemeral",
    payload: streamResyncRequiredPayloadSchema,
  },
  "stream.heartbeat": {
    stage: 0,
    persistence: "ephemeral",
    payload: streamHeartbeatPayloadSchema,
  },
  "stream.closing": {
    stage: 0,
    persistence: "ephemeral",
    payload: streamClosingPayloadSchema,
  },
  "stream.error": {
    stage: 0,
    persistence: "ephemeral",
    payload: streamErrorPayloadSchema,
  },
  "hello.tick": { stage: 0, persistence: "persisted", payload: helloTickPayloadSchema },
  "hello.laya": { stage: 0, persistence: "persisted", payload: helloLayaPayloadSchema },
  "run.created": { stage: 0, persistence: "persisted", payload: runCreatedPayloadSchema },
  "run.status_changed": {
    stage: 0,
    persistence: "persisted",
    payload: runStatusChangedPayloadSchema,
  },
  "run.finished": { stage: 0, persistence: "persisted", payload: runFinishedPayloadSchema },
  "run.progress": { stage: 2, persistence: "persisted", payload: runProgressPayloadSchema },
  "budget.updated": { stage: 2, persistence: "persisted", payload: budgetUpdatedPayloadSchema },
  "budget.exhausted": {
    stage: 2,
    persistence: "persisted",
    payload: budgetExhaustedPayloadSchema,
  },
  "scenario.queued": { stage: 2, persistence: "persisted", payload: scenarioQueuedPayloadSchema },
  "scenario.started": {
    stage: 2,
    persistence: "persisted",
    payload: scenarioStartedPayloadSchema,
  },
  "scenario.verdict": {
    stage: 2,
    persistence: "persisted",
    payload: scenarioVerdictPayloadSchema,
  },
  "scenario.finished": {
    stage: 2,
    persistence: "persisted",
    payload: scenarioFinishedPayloadSchema,
  },
  "step.recorded": { stage: 2, persistence: "persisted", payload: stepRecordedPayloadSchema },
  "browser_session.started": {
    stage: 2,
    persistence: "persisted",
    payload: browserSessionStartedPayloadSchema,
  },
  "browser_session.ended": {
    stage: 2,
    persistence: "persisted",
    payload: browserSessionEndedPayloadSchema,
  },
  "tile.frame": { stage: 2, persistence: "ephemeral", payload: tileFramePayloadSchema },
  "seed.progress": { stage: 3, persistence: "persisted", payload: seedProgressPayloadSchema },
  "step.graded": { stage: 4, persistence: "persisted", payload: stepGradedPayloadSchema },
  "invariant.result": {
    stage: 5,
    persistence: "persisted",
    payload: invariantResultPayloadSchema,
  },
  "finding.created": { stage: 5, persistence: "persisted", payload: findingCreatedPayloadSchema },
  "finding.updated": { stage: 5, persistence: "ephemeral", payload: findingUpdatedPayloadSchema },
  "finding.occurrence_added": {
    stage: 5,
    persistence: "ephemeral",
    payload: findingOccurrenceAddedPayloadSchema,
  },
  "scenario.changed": { stage: 6, persistence: "ephemeral", payload: scenarioChangedPayloadSchema },
  "coverage.updated": { stage: 6, persistence: "ephemeral", payload: coverageUpdatedPayloadSchema },
  "generation.progress": {
    stage: 6,
    persistence: "persisted",
    payload: generationProgressPayloadSchema,
  },
  "explore.action": { stage: 7, persistence: "persisted", payload: exploreActionPayloadSchema },
  "explore.candidate": {
    stage: 7,
    persistence: "persisted",
    payload: exploreCandidatePayloadSchema,
  },
  "explore.verified": { stage: 7, persistence: "persisted", payload: exploreVerifiedPayloadSchema },
  "sim.turn": { stage: 7, persistence: "persisted", payload: simTurnPayloadSchema },
  "sim.checked": { stage: 7, persistence: "persisted", payload: simCheckedPayloadSchema },
  "redteam.round_started": {
    stage: 7,
    persistence: "persisted",
    payload: redteamRoundStartedPayloadSchema,
  },
  "redteam.attack": { stage: 7, persistence: "persisted", payload: redteamAttackPayloadSchema },
  "redteam.round_finished": {
    stage: 7,
    persistence: "persisted",
    payload: redteamRoundFinishedPayloadSchema,
  },
  "replay.progress": { stage: 7, persistence: "persisted", payload: replayProgressPayloadSchema },
  "run.stop_requested": {
    stage: 7,
    persistence: "persisted",
    payload: runStopRequestedPayloadSchema,
  },
  "mutation.outcome": { stage: 8, persistence: "persisted", payload: mutationOutcomePayloadSchema },
  "notification.created": {
    stage: 8,
    persistence: "ephemeral",
    payload: notificationCreatedPayloadSchema,
  },
  "dashboard.invalidate": {
    stage: 8,
    persistence: "ephemeral",
    payload: dashboardInvalidatePayloadSchema,
  },
  "contract.progress": {
    stage: 9,
    persistence: "persisted",
    payload: contractProgressPayloadSchema,
  },
  "proposal.updated": {
    stage: 11,
    persistence: "ephemeral",
    payload: proposalUpdatedPayloadSchema,
  },
  "agent_session.changed": {
    stage: 11,
    persistence: "ephemeral",
    payload: agentSessionChangedPayloadSchema,
  },
} as const satisfies Record<string, EventDefinition>;

export type EventType = keyof typeof EVENT_REGISTRY;

export type PayloadOfEvent<Type extends EventType> = z.infer<
  (typeof EVENT_REGISTRY)[Type]["payload"]
>;

export type StreamEventOf<Type extends EventType> = {
  type: Type;
  run_id: string | null;
  seq: number | null;
  ts: string;
  payload: PayloadOfEvent<Type>;
};

export type KnownStreamEvent = { [Type in EventType]: StreamEventOf<Type> }[EventType];

type RegistryEntry<Type extends EventType> = (typeof EVENT_REGISTRY)[Type];

export type Phase0EventType = {
  [Type in EventType]: RegistryEntry<Type>["stage"] extends 0 ? Type : never;
}[EventType];

export type Phase0StreamEvent = Extract<KnownStreamEvent, { type: Phase0EventType }>;

export type LaterStageEventType = {
  [Type in EventType]: RegistryEntry<Type>["stage"] extends 0 ? never : Type;
}[EventType];

export type LaterStageStreamEvent = Extract<KnownStreamEvent, { type: LaterStageEventType }>;

export const FEED_ONLY_EVENT_TYPES = [
  "finding.updated",
  "finding.occurrence_added",
  "scenario.changed",
  "coverage.updated",
  "proposal.updated",
  "agent_session.changed",
  "notification.created",
  "dashboard.invalidate",
] as const satisfies readonly EventType[];

export type FeedOnlyEventType = (typeof FEED_ONLY_EVENT_TYPES)[number];

export type RunEventType = Exclude<
  Extract<
    EventType,
    | `run.${string}`
    | `budget.${string}`
    | `scenario.${string}`
    | `step.${string}`
    | `browser_session.${string}`
    | `seed.${string}`
    | `tile.${string}`
    | `invariant.${string}`
    | `finding.${string}`
    | `generation.${string}`
    | `explore.${string}`
    | `sim.${string}`
    | `redteam.${string}`
    | `replay.${string}`
    | `mutation.${string}`
    | `contract.${string}`
  >,
  FeedOnlyEventType
>;

export type RunStreamEvent = Extract<KnownStreamEvent, { type: RunEventType }>;

export type RunEventPayloads = { [Type in RunEventType]: PayloadOfEvent<Type> };

export const EVENT_TYPES = Object.keys(EVENT_REGISTRY) as EventType[];

export const PHASE_0_EVENT_TYPES = EVENT_TYPES.filter(
  (type) => EVENT_REGISTRY[type].stage === 0,
) as Phase0EventType[];

export const LATER_STAGE_EVENT_TYPES = EVENT_TYPES.filter(
  (type) => EVENT_REGISTRY[type].stage !== 0,
) as LaterStageEventType[];

const RUN_EVENT_PREFIXES = [
  "run.",
  "budget.",
  "scenario.",
  "step.",
  "browser_session.",
  "seed.",
  "tile.",
  "invariant.",
  "finding.",
  "generation.",
  "explore.",
  "sim.",
  "redteam.",
  "replay.",
  "mutation.",
  "contract.",
] as const;

export function isFeedOnlyEventType(type: EventType): type is FeedOnlyEventType {
  return (FEED_ONLY_EVENT_TYPES as readonly EventType[]).includes(type);
}

export function isRunEventType(type: EventType): type is RunEventType {
  return (
    RUN_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix)) && !isFeedOnlyEventType(type)
  );
}

export function isRunStreamEvent(event: KnownStreamEvent): event is RunStreamEvent {
  return isRunEventType(event.type);
}

export const RUN_EVENT_TYPES = EVENT_TYPES.filter(isRunEventType);

export const FEED_EVENT_TYPES = {
  runs: [
    "run.created",
    "run.status_changed",
    "run.progress",
    "run.finished",
    "budget.updated",
    "budget.exhausted",
    "run.stop_requested",
  ],
  home: [
    "run.created",
    "run.status_changed",
    "run.finished",
    "budget.exhausted",
    "finding.created",
    "notification.created",
    "dashboard.invalidate",
    "agent_session.changed",
  ],
  coverage: ["coverage.updated", "scenario.changed", "generation.progress", "proposal.updated"],
  findings: ["finding.created", "finding.updated", "finding.occurrence_added"],
} as const satisfies Record<Schemas["FeedName"], readonly EventType[]>;

export function isFeedEventType(feed: Schemas["FeedName"], type: EventType): boolean {
  return (FEED_EVENT_TYPES[feed] as readonly EventType[]).includes(type);
}

export const streamEnvelopeSchema = z.object({
  type: z.string().min(1),
  run_id: z.string().nullable(),
  seq: z.number().int().min(1).nullable(),
  ts: timestampSchema,
  payload: z.record(z.string(), z.unknown()),
});

export type StreamEnvelope = z.infer<typeof streamEnvelopeSchema>;

export type ParsedStreamMessage =
  | { kind: "known"; event: KnownStreamEvent }
  | { kind: "unknown"; type: string; seq: number | null }
  | { kind: "invalid"; type: string | null; seq: number | null; reason: string };

export function isKnownEventType(type: string): type is EventType {
  return Object.hasOwn(EVENT_REGISTRY, type);
}

export function persistenceOf(type: EventType): EventPersistence {
  return EVENT_REGISTRY[type].persistence;
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "invalid";
  }
  const location = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${location}${issue.message}`;
}

export function parseStreamMessage(raw: unknown): ParsedStreamMessage {
  const envelope = streamEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { kind: "invalid", type: null, seq: null, reason: describeIssue(envelope.error) };
  }
  const { type, seq } = envelope.data;
  if (!isKnownEventType(type)) {
    return { kind: "unknown", type, seq };
  }
  if (EVENT_REGISTRY[type].persistence === "persisted" && seq === null) {
    return { kind: "invalid", type, seq, reason: "a persisted event needs a seq" };
  }
  const payload = EVENT_REGISTRY[type].payload.safeParse(envelope.data.payload);
  if (!payload.success) {
    return { kind: "invalid", type, seq, reason: describeIssue(payload.error) };
  }
  return {
    kind: "known",
    event: { ...envelope.data, type, payload: payload.data } as KnownStreamEvent,
  };
}

export function parseStreamText(text: string): ParsedStreamMessage {
  try {
    return parseStreamMessage(JSON.parse(text));
  } catch {
    return { kind: "invalid", type: null, seq: null, reason: "not valid JSON" };
  }
}

export const tileSubscriptionSchema = z.object({
  browser_session_id: identifierSchema,
  mode: z.enum(["grid", "focus"]),
}) satisfies z.ZodType<Schemas["TileSubscription"]>;

export const tileSubscribeMessageSchema = z.object({
  type: z.literal("tile.subscribe"),
  payload: z.object({ tiles: z.array(tileSubscriptionSchema) }),
}) satisfies z.ZodType<Schemas["TileSubscribeMessage"]>;

export const tileAckMessageSchema = z.object({
  type: z.literal("tile.ack"),
  payload: z.object({ browser_session_id: identifierSchema, frame_seq: countSchema }),
}) satisfies z.ZodType<Schemas["TileAckMessage"]>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  tileSubscribeMessageSchema,
  tileAckMessageSchema,
]);

export type ClientMessage = Schemas["StreamClientMessage"];

export type TileSubscription = Schemas["TileSubscription"];

export function tileSubscribeMessage(tiles: readonly TileSubscription[]): ClientMessage {
  return { type: "tile.subscribe", payload: { tiles: [...tiles] } };
}

export function tileAckMessage(browserSessionId: string, frameSeq: number): ClientMessage {
  return {
    type: "tile.ack",
    payload: { browser_session_id: browserSessionId, frame_seq: frameSeq },
  };
}

export type TileFramePayload = PayloadOfEvent<"tile.frame">;

export type StreamLimits = Schemas["StreamLimits"];
