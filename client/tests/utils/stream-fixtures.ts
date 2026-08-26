import type { EventType, PayloadOfEvent } from "@/features/streams/events";

export const FIXTURE_RUN_ID = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11";
export const FIXTURE_USER_ID = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e22";
export const FIXTURE_SESSION_ID = "0198f6f2-8a11-7c33-8e02-19d0a5a7c9b4";
export const FIXTURE_TIMESTAMP = "2026-09-30T14:03:22.123Z";
export const FIXTURE_RUN_SCENARIO_ID = "0198f6f2-7b00-7a00-9d00-000000000001";
export const FIXTURE_SCENARIO_ID = "0198f6f2-7b00-7a00-9d00-000000000002";
export const FIXTURE_STEP_ID = "0198f6f2-8a11-7c33-8e02-19d0a5a7c9b5";
export const FIXTURE_FINDING_ID = "0198f6f2-9c00-7b00-8a00-000000000001";
export const FIXTURE_TARGET_ID = "0198f6f2-9c00-7b00-8a00-000000000002";
export const FIXTURE_CELL_ID = "0198f6f2-9c00-7b00-8a00-000000000003";
export const FIXTURE_CANDIDATE_ID = "0198f6f2-9c00-7b00-8a00-000000000004";
export const FIXTURE_SIM_SESSION_ID = "0198f6f2-9c00-7b00-8a00-000000000005";
export const FIXTURE_ROUND_ID = "0198f6f2-9c00-7b00-8a00-000000000006";
export const FIXTURE_ATTACK_ID = "0198f6f2-9c00-7b00-8a00-000000000007";
export const FIXTURE_REPLAY_ID = "0198f6f2-9c00-7b00-8a00-000000000008";
export const FIXTURE_MUTATION_RUN_ID = "0198f6f2-9c00-7b00-8a00-000000000009";
export const FIXTURE_NOTIFICATION_ID = "0198f6f2-9c00-7b00-8a00-00000000000a";
export const FIXTURE_CONTRACT_CHECK_ID = "0198f6f2-9c00-7b00-8a00-00000000000b";
export const FIXTURE_PROPOSAL_ID = "0198f6f2-9c00-7b00-8a00-00000000000c";
export const FIXTURE_PROPOSAL_ITEM_ID = "0198f6f2-9c00-7b00-8a00-00000000000d";
export const FIXTURE_AGENT_SESSION_ID = "0198f6f2-9c00-7b00-8a00-00000000000e";

export interface WireEnvelope {
  type: string;
  run_id: string | null;
  seq: number | null;
  ts: string;
  payload: Record<string, unknown>;
}

const countersFixture = {
  scenarios_total: 0,
  scenarios_done: 0,
  pass: 0,
  fail: 0,
  flaky: 0,
  uncertain: 0,
  skipped: 0,
  steps_recorded: 0,
};

const verdictFixture = {
  status: "pass",
  tier: "code",
  confidence: 0.92,
  reason_code: null,
  reason: null,
  skip_reason: null,
} as const;

export const payloadFixtures: { [Type in EventType]: PayloadOfEvent<Type> } = {
  "stream.hello": {
    run_id: FIXTURE_RUN_ID,
    head_seq: 0,
    resumed_from: null,
    heartbeat_seconds: 15,
    limits: {
      max_tiles: 12,
      grid: { max_fps: 4, quality: 60, max_width: 640 },
      focus: { max_fps: 10, quality: 75, max_width: 1280 },
    },
    feed: null,
  },
  "stream.replay_end": { through_seq: 0 },
  "stream.resync_required": { reason: "gap_too_large", min_seq: 10 },
  "stream.heartbeat": {},
  "stream.closing": { reason: "max_age" },
  "stream.error": { code: "internal_error", message: "boom" },
  "hello.tick": { n: 1, total: 3, message: "hello tick 1 of 3" },
  "hello.laya": { ok: true, latency_ms: 14, status_code: 200, error: null },
  "run.created": {
    kind: "hello",
    target_id: null,
    plan_id: null,
    trigger: "manual",
    created_by: FIXTURE_USER_ID,
    status: "queued",
  },
  "run.status_changed": { status: "running", previous: "queued", reason: null },
  "run.finished": {
    status: "completed",
    counters: countersFixture,
    spent_usd: 0,
    duration_ms: 1200,
  },
  "run.progress": { ...countersFixture, scenarios_total: 12, scenarios_done: 3, pass: 2, fail: 1 },
  "budget.updated": { max_usd: 5, spent_usd: 0.42, max_minutes: 30, elapsed_ms: 61_000 },
  "budget.exhausted": { dimension: "usd", limit: 5, actual: 5.01 },
  "scenario.queued": {
    run_scenario_id: FIXTURE_RUN_SCENARIO_ID,
    scenario_id: FIXTURE_SCENARIO_ID,
    title: "Smart Log read",
    role: "manager",
    interface_id: "web",
    attempts_total: 3,
  },
  "scenario.started": { run_scenario_id: FIXTURE_RUN_SCENARIO_ID, attempt: 0 },
  "scenario.verdict": {
    run_scenario_id: FIXTURE_RUN_SCENARIO_ID,
    attempt: 0,
    verdict: verdictFixture,
  },
  "scenario.finished": {
    run_scenario_id: FIXTURE_RUN_SCENARIO_ID,
    status: "finished",
    verdict: verdictFixture,
    attempts: { passed: 3, failed: 0, total: 3 },
    duration_ms: 8400,
  },
  "step.recorded": {
    step_id: FIXTURE_STEP_ID,
    run_scenario_id: FIXTURE_RUN_SCENARIO_ID,
    attempt: 0,
    index: 3,
    adapter: "browser",
    label: "click Send",
    ok: true,
    latency_ms: 412,
    cost_usd: 0,
    tier0_failure_count: 0,
    screenshot_count: 1,
  },
  "step.graded": {
    step_id: FIXTURE_STEP_ID,
    run_scenario_id: FIXTURE_RUN_SCENARIO_ID,
    verdict: verdictFixture,
    escalated_to: null,
  },
  "seed.progress": {
    phase: "assert",
    status: "ok",
    observed_hash: "9f2c1d7a6b3e4f5a8c0d1e2f3a4b5c6d",
    expected_hash: "9f2c1d7a6b3e4f5a8c0d1e2f3a4b5c6d",
  },
  "browser_session.started": {
    browser_session_id: FIXTURE_SESSION_ID,
    run_scenario_id: "0198f6f2-7b00-7a00-9d00-000000000001",
    attempt: 0,
    viewport: { width: 1280, height: 800 },
    scenario_title: "Open the dashboard",
    started_at: FIXTURE_TIMESTAMP,
  },
  "browser_session.ended": {
    browser_session_id: FIXTURE_SESSION_ID,
    run_scenario_id: "0198f6f2-7b00-7a00-9d00-000000000001",
    has_recording: true,
    has_trace: false,
    ended_at: FIXTURE_TIMESTAMP,
  },
  "tile.frame": {
    browser_session_id: FIXTURE_SESSION_ID,
    frame_seq: 1,
    mime: "image/jpeg",
    width: 640,
    height: 400,
    data_b64: "/9j/4AAQSkZJRg==",
    page_url: null,
    captured_at: FIXTURE_TIMESTAMP,
  },
  "invariant.result": {
    invariant_id: "no_5xx",
    pack: "generic",
    run_scenario_id: FIXTURE_RUN_SCENARIO_ID,
    attempt: 0,
    status: "pass",
    tier: "code",
    message: "no response had a 5xx status",
    skip_reason: null,
  },
  "finding.created": {
    finding_id: FIXTURE_FINDING_ID,
    title: "Calendar reply leaks an internal id",
    class: "invariant_violation",
    severity: "high",
    status: "new",
    fingerprint: "inv:no_internal_ids:calendar",
    is_new: true,
    scenario_id: FIXTURE_SCENARIO_ID,
  },
  "finding.updated": {
    finding_id: FIXTURE_FINDING_ID,
    changes: { status: { from: "new", to: "triaged" } },
  },
  "finding.occurrence_added": {
    finding_id: FIXTURE_FINDING_ID,
    run_id: FIXTURE_RUN_ID,
    occurrence_count: 2,
  },
  "scenario.changed": {
    scenario_id: FIXTURE_SCENARIO_ID,
    status: "in_review",
    cell_id: FIXTURE_CELL_ID,
  },
  "coverage.updated": {
    target_id: FIXTURE_TARGET_ID,
    plan_id: null,
    cell_ids: [FIXTURE_CELL_ID],
    reason: "generated",
  },
  "proposal.updated": {
    target_id: FIXTURE_TARGET_ID,
    proposal_id: FIXTURE_PROPOSAL_ID,
    item_id: FIXTURE_PROPOSAL_ITEM_ID,
    status: "selected",
  },
  "agent_session.changed": {
    agent_session_id: FIXTURE_AGENT_SESSION_ID,
    user_id: FIXTURE_USER_ID,
    target_id: FIXTURE_TARGET_ID,
    active: true,
  },
  "generation.progress": {
    cells_total: 4,
    cells_done: 1,
    scenarios_created: 3,
    scenarios_invalid: 0,
  },
  "explore.action": {
    index: 1,
    action: "click",
    target: "Send",
    text: null,
    url: null,
    rationale: "open the private document list",
  },
  "explore.candidate": {
    candidate_id: FIXTURE_CANDIDATE_ID,
    description: "the private document list is visible to a team member",
    from_index: 1,
    to_index: 4,
  },
  "explore.verified": {
    candidate_id: FIXTURE_CANDIDATE_ID,
    verified: true,
    replay_run_scenario_id: FIXTURE_RUN_SCENARIO_ID,
    finding_id: FIXTURE_FINDING_ID,
  },
  "sim.turn": {
    sim_session_id: FIXTURE_SIM_SESSION_ID,
    turn: 1,
    speaker: "persona",
    text_preview: "Hi, I need to move my booking",
  },
  "sim.checked": {
    sim_session_id: FIXTURE_SIM_SESSION_ID,
    checks: {
      end_state: "pass",
      calls: "pass",
      invariants: "pass",
      goal: "pass",
      dialogue: "uncertain",
    },
    verdict: verdictFixture,
  },
  "redteam.round_started": { round_id: FIXTURE_ROUND_ID, index: 1, family: "prompt_injection" },
  "redteam.attack": {
    attack_id: FIXTURE_ATTACK_ID,
    round_id: FIXTURE_ROUND_ID,
    family: "prompt_injection",
    outcome: "blocked",
  },
  "redteam.round_finished": {
    round_id: FIXTURE_ROUND_ID,
    index: 1,
    attacks: 5,
    candidates: 0,
    dry: true,
  },
  "replay.progress": {
    replay_id: FIXTURE_REPLAY_ID,
    records_total: 40,
    cases_created: 12,
    cases_rejected: 3,
  },
  "run.stop_requested": { requested_by: FIXTURE_USER_ID },
  "mutation.outcome": {
    mutation_run_id: FIXTURE_MUTATION_RUN_ID,
    invariant_id: "tenant_isolation",
    outcome: "killed",
    caught_by: [FIXTURE_SCENARIO_ID],
  },
  "notification.created": {
    notification_id: FIXTURE_NOTIFICATION_ID,
    kind: "nightly_summary",
    severity: "info",
    title: "Nightly run finished",
    link: "/runs/0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11",
  },
  "dashboard.invalidate": {},
  "contract.progress": {
    contract_check_id: FIXTURE_CONTRACT_CHECK_ID,
    items_total: 6,
    items_done: 2,
    breaking: 1,
  },
};

export function envelope(
  type: string,
  seq: number | null,
  payload: Record<string, unknown> = {},
  overrides: Partial<WireEnvelope> = {},
): WireEnvelope {
  return {
    type,
    run_id: FIXTURE_RUN_ID,
    seq,
    ts: FIXTURE_TIMESTAMP,
    payload,
    ...overrides,
  };
}

export function knownEnvelope<Type extends EventType>(
  type: Type,
  seq: number | null,
  payload: Partial<PayloadOfEvent<Type>> = {},
  overrides: Partial<WireEnvelope> = {},
): WireEnvelope {
  return envelope(type, seq, { ...payloadFixtures[type], ...payload }, overrides);
}

export function helloEnvelope(resumedFrom: number | null = null, headSeq = 0): WireEnvelope {
  return knownEnvelope("stream.hello", null, { resumed_from: resumedFrom, head_seq: headSeq });
}

export function replayEndEnvelope(throughSeq: number): WireEnvelope {
  return knownEnvelope("stream.replay_end", null, { through_seq: throughSeq });
}

export function tickEnvelope(seq: number, total = 3): WireEnvelope {
  return knownEnvelope("hello.tick", seq, {
    n: seq,
    total,
    message: `hello tick ${seq} of ${total}`,
  });
}

export function heartbeatEnvelope(): WireEnvelope {
  return knownEnvelope("stream.heartbeat", null);
}
