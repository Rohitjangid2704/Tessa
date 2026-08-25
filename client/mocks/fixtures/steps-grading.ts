import type { StepContent } from "../simulation/step-content";
import { stableId } from "../stage2/ids";
import { buildProbeBank, PROBE_BANK_VERSION } from "./probe-bank";
import { ORACLE_RESULT_IDS } from "./oracle-templates";
import { registerStepFixtureGroup, type StepFixture } from "./steps";
import type {
  EvidenceBlock,
  GoldPoint,
  JudgeResult,
  ProbeResult,
  ProbeStatus,
  SseStepEvent,
  Tier0Failure,
  Tier0Result,
  Verdict,
  VerdictStatus,
  VerdictTier,
} from "@/lib/api/types";

export const GRADING_GROUPS = {
  tier0: "grading-tier0",
  probes: "grading-probes",
  judge: "grading-judge",
  uncertain: "grading-uncertain",
  stub: "grading-stub",
} as const;

const API_BASE = "https://gracie-api.qa.example.test";
const AUTHORIZATION = "Bearer ${GRACIE_ADMIN_TOKEN}";
const PASSED: Tier0Result = { passed: true, failures: [] };
const TOKEN_WORDS = 4;
const FIRST_TOKEN_MS = 300;
const TOKEN_GAP_MS = 80;
const PROBE_TIMEOUT_MS = 30000;
const JUDGE_RUBRIC =
  "Pass when the answer addresses the question and every claim is backed by a gold point. Fail when it contradicts a gold point or makes a forbidden claim. Say uncertain when you cannot tell.";
const JUDGE_RUBRIC_VERSION = "judge-rubric.v1";
const ISSUE_DETAIL = ORACLE_RESULT_IDS.issueDetailOk;

const BANK = new Map(buildProbeBank().map((probe) => [probe.id, probe]));

function failedTier0(failures: Tier0Failure[]): Tier0Result {
  return { passed: false, failures };
}

function verdictOf(
  status: VerdictStatus,
  tier: VerdictTier,
  confidence: number | null,
  reasonCode: string,
  reason: string | null,
): Verdict {
  return {
    status,
    tier,
    confidence,
    reason_code: reasonCode,
    reason,
    skip_reason: null,
  };
}

function tokenEvents(answer: string | null): SseStepEvent[] {
  if (answer === null) {
    return [];
  }
  const words = answer.split(" ");
  const events: SseStepEvent[] = [];
  for (let index = 0; index < words.length; index += TOKEN_WORDS) {
    events.push({
      event: "token",
      data: JSON.stringify({ text: `${words.slice(index, index + TOKEN_WORDS).join(" ")} ` }),
      at_ms: FIRST_TOKEN_MS + events.length * TOKEN_GAP_MS,
    });
  }
  events.push({ event: "done", data: "{}", at_ms: FIRST_TOKEN_MS + events.length * TOKEN_GAP_MS });
  return events;
}

function gold(key: string, value: unknown, rendered: string): GoldPoint {
  return { key, value, rendered, oracle_result_id: ISSUE_DETAIL };
}

interface ProbeOutcome {
  answer: string | null;
  status: ProbeStatus;
  confidence: number;
  latencyMs: number;
  threshold?: number;
}

function probeResult(
  group: string,
  step: string,
  probeId: string,
  outcome: ProbeOutcome,
): ProbeResult {
  const probe = BANK.get(probeId);
  if (probe === undefined) {
    throw new Error(`probe ${probeId} is not in the mock probe bank`);
  }
  return {
    id: stableId("probe_result", group, step, probeId),
    probe_id: probe.id,
    pack: probe.pack,
    question: probe.question,
    answer: outcome.answer,
    status: outcome.status,
    confidence: outcome.confidence,
    threshold: outcome.threshold ?? probe.threshold,
    latency_ms: outcome.latencyMs,
    probe_bank_version: PROBE_BANK_VERSION,
    engine: "laya",
  };
}

interface JudgeInput {
  group: string;
  step: string;
  family: JudgeResult["family"];
  model: string;
  verdict: Verdict;
  swappedAgrees: boolean | null;
  costUsd: number;
  mustNotClaim: string[];
  unsupportedClaims: string[];
  goldPoints: GoldPoint[];
}

function judgeResult(input: JudgeInput): JudgeResult {
  return {
    id: stableId("judge_result", input.group, input.step),
    family: input.family,
    model: input.model,
    effort: "low",
    rubric_version: JUDGE_RUBRIC_VERSION,
    verdict: input.verdict,
    pairwise: input.swappedAgrees === null ? null : { swapped_agrees: input.swappedAgrees },
    evidence: {
      gold_points: input.goldPoints.map(({ key, value, rendered }) => ({ key, value, rendered })),
      must_not_claim: input.mustNotClaim,
      unsupported_claims: input.unsupportedClaims,
    },
    cost_usd: input.costUsd,
  };
}

interface EvidenceInput {
  ask: string;
  answer: string;
  goldPoints: GoldPoint[];
  mustNotClaim: string[];
  unsupportedCandidates: string[];
  invariants?: { id: string; rule: string }[];
}

function evidenceBlock(input: EvidenceInput): EvidenceBlock {
  return {
    ask: input.ask,
    answer: input.answer,
    gold_points: input.goldPoints.map(({ key, value, rendered }) => ({ key, value, rendered })),
    invariants: input.invariants ?? [],
    must_not_claim: input.mustNotClaim,
    rubric: JUDGE_RUBRIC,
    unsupported_claim_candidates: input.unsupportedCandidates,
  };
}

interface ChatStepInput {
  ask: string;
  answer: string;
  latencyMs: number;
  tier0?: Tier0Result;
  ok?: boolean | null;
  verdict: Verdict | null;
  goldPoints?: GoldPoint[];
  probes?: ProbeResult[];
  judge?: JudgeResult | null;
  evidence?: EvidenceBlock | null;
}

function chatStep(name: string, input: ChatStepInput): StepFixture {
  const content: StepContent = {
    adapter: "sse",
    label: input.ask,
    request: {
      kind: "sse",
      method: "POST",
      url: `${API_BASE}/api/v1/chat`,
      headers: {
        Authorization: AUTHORIZATION,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      query: null,
      body: { message: input.ask },
    },
    response: { kind: "sse", status: 200, events: tokenEvents(input.answer), closed_by: "server" },
    response_truncated: false,
    payload_purged: false,
    ask: input.ask,
    answer: input.answer,
    tools: [],
    cards: [],
    latency_ms: input.latencyMs,
    cost_usd: 0,
    tier0: input.tier0 ?? PASSED,
    ok: input.ok === undefined ? true : input.ok,
    artifacts: [],
    verdict: input.verdict,
    gold_points: input.goldPoints ?? [],
    db_checks: [],
    probes: input.probes ?? [],
    judge: input.judge ?? null,
    evidence: input.evidence ?? null,
  };
  return { name, content };
}

const BREAKFAST_ASK = "What time is breakfast?";
const BREAKFAST_ANSWER = "Breakfast starts at 6:30 and the buffet is open all morning.";
const TIER0_REASON = "The answer does not mention 10:30";

const TIER0_STEPS: StepFixture[] = [
  chatStep("tier0Fail", {
    ask: BREAKFAST_ASK,
    answer: BREAKFAST_ANSWER,
    latencyMs: 940,
    tier0: failedTier0([
      {
        check: "text_contains",
        message: TIER0_REASON,
        expected: "10:30",
        actual: BREAKFAST_ANSWER,
      },
      {
        check: "latency",
        message: "The reply took 940 ms, over the 800 ms budget",
        expected: 800,
        actual: 940,
      },
    ]),
    verdict: verdictOf("fail", "code", 1, "tier0_failed", TIER0_REASON),
  }),
  chatStep("notGraded", {
    ask: "Is the pool open today?",
    answer: "The pool is open from 8:00 to 20:00 every day.",
    latencyMs: 1210,
    ok: null,
    verdict: null,
  }),
];

const GARDEN_ANSWER =
  "The Garden Room is on the ground floor next to the lobby. Breakfast is served there from 6:30 to 10:30.";

const DECIDED_PROBES: ProbeResult[] = [
  probeResult(GRADING_GROUPS.probes, "probeDecided", "generic.answers_the_question", {
    answer: "yes",
    status: "decided",
    confidence: 0.93,
    latencyMs: 212,
  }),
  probeResult(GRADING_GROUPS.probes, "probeDecided", "llm_app.cites_source", {
    answer: "no",
    status: "decided",
    confidence: 0.88,
    latencyMs: 187,
  }),
];

const OUT_OF_RANGE_PROBES: ProbeResult[] = [
  probeResult(GRADING_GROUPS.probes, "probeOutOfRange", "generic.tone", {
    answer: "polite",
    status: "decided",
    confidence: 1.2,
    latencyMs: 164,
  }),
  probeResult(GRADING_GROUPS.probes, "probeOutOfRange", "generic.language_matches_user", {
    answer: "yes",
    status: "decided",
    confidence: 0.97,
    latencyMs: 141,
    threshold: -0.1,
  }),
];

const ERROR_PROBES: ProbeResult[] = [
  probeResult(GRADING_GROUPS.probes, "probeError", "generic.answers_the_question", {
    answer: "yes",
    status: "decided",
    confidence: 0.9,
    latencyMs: 198,
  }),
  probeResult(GRADING_GROUPS.probes, "probeError", "generic.mentions_error", {
    answer: null,
    status: "error",
    confidence: 0,
    latencyMs: PROBE_TIMEOUT_MS,
  }),
];

const PROBE_STEPS: StepFixture[] = [
  chatStep("probeDecided", {
    ask: "Where is the Garden Room?",
    answer: GARDEN_ANSWER,
    latencyMs: 1380,
    probes: DECIDED_PROBES,
    verdict: verdictOf(
      "pass",
      "laya",
      0.88,
      "probes_decided",
      "Laya decided 2 probes at or above their thresholds",
    ),
  }),
  chatStep("probeOutOfRange", {
    ask: "Can you recommend a quiet table for two?",
    answer: "Of course. The terrace has quiet tables for two after 20:00.",
    latencyMs: 1150,
    probes: OUT_OF_RANGE_PROBES,
    verdict: verdictOf(
      "pass",
      "laya",
      0.97,
      "probes_decided",
      "Laya decided 2 probes at or above their thresholds",
    ),
  }),
  chatStep("probeError", {
    ask: "Can I get a late checkout?",
    answer: "Late checkout can be arranged at the front desk until 14:00.",
    latencyMs: 1290,
    probes: ERROR_PROBES,
    verdict: verdictOf(
      "uncertain",
      "laya",
      null,
      "probe_error",
      "Laya did not answer one probe, so the step could not be decided",
    ),
  }),
];

const PIPE_ASK = "What is the status of the leaking pipe in room 412?";
const PIPE_ANSWER =
  "The leaking pipe in room 412 is still open. It is assigned to Maya Rossi and a plumber is booked for tomorrow.";
const PIPE_GOLD = [
  gold("issue_status", "open", "open"),
  gold("issue_assignee", "Maya Rossi", "Maya Rossi"),
  gold("issue_room", "412", "412"),
];
const PIPE_FORBIDDEN = ["The issue is closed", "nobody is assigned"];
const PIPE_UNSUPPORTED = ["a plumber is booked for tomorrow"];

const PIPE_JUDGE = judgeResult({
  group: GRADING_GROUPS.judge,
  step: "probeUncertainThenJudge",
  family: "openai",
  model: "gpt-5-mini",
  verdict: verdictOf(
    "pass",
    "judge",
    0.82,
    "judge_pass",
    "The answer matches all three gold points. One extra claim is not backed by the data.",
  ),
  swappedAgrees: true,
  costUsd: 0.0023,
  mustNotClaim: [],
  unsupportedClaims: PIPE_UNSUPPORTED,
  goldPoints: PIPE_GOLD,
});

const ROOM_ASK = "Is the issue in room 208 assigned to anyone?";
const ROOM_ANSWER =
  "Yes, the issue in room 208 is assigned to Maya Rossi. It was closed this morning and needs no further work.";
const ROOM_GOLD = [gold("issue_status", "open", "open"), gold("issue_assignee", null, "nobody")];
const ROOM_FORBIDDEN = ["closed this morning", "assigned to Maya Rossi"];

const ROOM_JUDGE = judgeResult({
  group: GRADING_GROUPS.judge,
  step: "judgeTiebreak",
  family: "anthropic",
  model: "claude-sonnet-5-5",
  verdict: verdictOf(
    "fail",
    "judge",
    0.84,
    "judge_fail",
    "The answer says the issue is closed and assigned, which contradicts both gold points.",
  ),
  swappedAgrees: false,
  costUsd: 0.0187,
  mustNotClaim: ["closed this morning"],
  unsupportedClaims: ["assigned to Maya Rossi"],
  goldPoints: ROOM_GOLD,
});

const JUDGE_STEPS: StepFixture[] = [
  chatStep("probeUncertainThenJudge", {
    ask: PIPE_ASK,
    answer: PIPE_ANSWER,
    latencyMs: 1730,
    goldPoints: PIPE_GOLD,
    probes: [
      probeResult(GRADING_GROUPS.judge, "probeUncertainThenJudge", "llm_app.cites_source", {
        answer: "no",
        status: "uncertain",
        confidence: 0.52,
        latencyMs: 233,
      }),
      probeResult(GRADING_GROUPS.judge, "probeUncertainThenJudge", "generic.answers_the_question", {
        answer: "yes",
        status: "decided",
        confidence: 0.91,
        latencyMs: 176,
      }),
    ],
    judge: PIPE_JUDGE,
    evidence: evidenceBlock({
      ask: PIPE_ASK,
      answer: PIPE_ANSWER,
      goldPoints: PIPE_GOLD,
      mustNotClaim: PIPE_FORBIDDEN,
      unsupportedCandidates: PIPE_UNSUPPORTED,
      invariants: [
        {
          id: "external_facts_labelled",
          rule: "Facts that do not come from the property data are labelled as such",
        },
      ],
    }),
    verdict: PIPE_JUDGE.verdict,
  }),
  chatStep("judgeTiebreak", {
    ask: ROOM_ASK,
    answer: ROOM_ANSWER,
    latencyMs: 1560,
    goldPoints: ROOM_GOLD,
    probes: [
      probeResult(GRADING_GROUPS.judge, "judgeTiebreak", "generic.answers_the_question", {
        answer: "yes",
        status: "uncertain",
        confidence: 0.58,
        latencyMs: 241,
      }),
    ],
    judge: ROOM_JUDGE,
    evidence: evidenceBlock({
      ask: ROOM_ASK,
      answer: ROOM_ANSWER,
      goldPoints: ROOM_GOLD,
      mustNotClaim: ROOM_FORBIDDEN,
      unsupportedCandidates: ["assigned to Maya Rossi"],
    }),
    verdict: ROOM_JUDGE.verdict,
  }),
];

const BLIND_ASK = "Who is fixing the broken blind in room 20011?";
const BLIND_ANSWER =
  "The broken blind in room 20011 is being fixed by the maintenance team. A technician should arrive soon.";
const BLIND_GOLD = [
  gold("issue_assignee", "Leo Fischer", "Leo Fischer"),
  gold("issue_room", "20011", "20011"),
];

const BLIND_JUDGE = judgeResult({
  group: GRADING_GROUPS.uncertain,
  step: "judgeDisagrees",
  family: "anthropic",
  model: "claude-sonnet-5-5",
  verdict: verdictOf(
    "uncertain",
    "judge",
    0.5,
    "judge_disagreement",
    "The two presentation orders disagreed and the tie-break could not decide.",
  ),
  swappedAgrees: false,
  costUsd: 0.0192,
  mustNotClaim: [],
  unsupportedClaims: ["A technician should arrive soon"],
  goldPoints: BLIND_GOLD,
});

const UNCERTAIN_STEPS: StepFixture[] = [
  chatStep("judgeDisagrees", {
    ask: BLIND_ASK,
    answer: BLIND_ANSWER,
    latencyMs: 1620,
    goldPoints: BLIND_GOLD,
    probes: [
      probeResult(GRADING_GROUPS.uncertain, "judgeDisagrees", "generic.answers_the_question", {
        answer: "yes",
        status: "uncertain",
        confidence: 0.55,
        latencyMs: 229,
      }),
      probeResult(GRADING_GROUPS.uncertain, "judgeDisagrees", "generic.admits_uncertainty", {
        answer: "no",
        status: "decided",
        confidence: 0.81,
        latencyMs: 158,
      }),
    ],
    judge: BLIND_JUDGE,
    evidence: evidenceBlock({
      ask: BLIND_ASK,
      answer: BLIND_ANSWER,
      goldPoints: BLIND_GOLD,
      mustNotClaim: [],
      unsupportedCandidates: ["A technician should arrive soon"],
    }),
    verdict: BLIND_JUDGE.verdict,
  }),
];

const PET_ASK = "Can I bring my dog to the restaurant?";
const PET_ANSWER = "Pets are welcome on the terrace but not inside the restaurant.";

const STUB_JUDGE = judgeResult({
  group: GRADING_GROUPS.stub,
  step: "stubModelJudge",
  family: "openai",
  model: "stub",
  verdict: verdictOf(
    "pass",
    "judge",
    0.5,
    "stub_model",
    "Canned verdict from the stub model. No provider was called.",
  ),
  swappedAgrees: null,
  costUsd: 0,
  mustNotClaim: [],
  unsupportedClaims: [],
  goldPoints: [],
});

const STUB_STEPS: StepFixture[] = [
  chatStep("stubModelJudge", {
    ask: PET_ASK,
    answer: PET_ANSWER,
    latencyMs: 1240,
    probes: [
      probeResult(GRADING_GROUPS.stub, "stubModelJudge", "generic.answers_the_question", {
        answer: "yes",
        status: "uncertain",
        confidence: 0.6,
        latencyMs: 205,
      }),
    ],
    judge: STUB_JUDGE,
    evidence: evidenceBlock({
      ask: PET_ASK,
      answer: PET_ANSWER,
      goldPoints: [],
      mustNotClaim: [],
      unsupportedCandidates: [],
    }),
    verdict: STUB_JUDGE.verdict,
  }),
];

registerStepFixtureGroup({
  key: GRADING_GROUPS.tier0,
  cell: {
    feature_id: "streaming.stream.chat_reply",
    role: "admin",
    interface_id: "chat_sse",
  },
  attempts: [{ outcome: "fail", steps: TIER0_STEPS }],
});

registerStepFixtureGroup({
  key: GRADING_GROUPS.probes,
  cell: {
    feature_id: "streaming.stream.chat_reply",
    role: "front_desk",
    interface_id: "chat_sse",
  },
  attempts: [{ outcome: "pass", steps: PROBE_STEPS }],
});

registerStepFixtureGroup({
  key: GRADING_GROUPS.judge,
  cell: {
    feature_id: "smart_log.read.issue_detail",
    role: "housekeeping_lead",
    interface_id: "chat_sse",
  },
  attempts: [{ outcome: "fail", steps: JUDGE_STEPS }],
});

registerStepFixtureGroup({
  key: GRADING_GROUPS.uncertain,
  cell: {
    feature_id: "smart_log.read.issue_detail",
    role: "manager",
    interface_id: "chat_sse",
  },
  attempts: [{ outcome: "pass", steps: UNCERTAIN_STEPS }],
});

registerStepFixtureGroup({
  key: GRADING_GROUPS.stub,
  cell: {
    feature_id: "streaming.stream.chat_reply",
    role: "housekeeping_lead",
    interface_id: "chat_sse",
  },
  attempts: [{ outcome: "pass", steps: STUB_STEPS }],
});
