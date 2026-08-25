import { buildProbeBank, PROBE_BANK_VERSION } from "../fixtures/probe-bank";
import { stableId, stableInt, stableUnit } from "../stage2/ids";
import type {
  EvidenceBlock,
  EvidenceGoldPoint,
  JudgeResult,
  Probe,
  ProbeResult,
  Step,
  Verdict,
  VerdictStatus,
  VerdictTier,
} from "@/lib/api/types";

export const ESCALATION_RATE = 0.1;
export const SYNTHETIC_JUDGE_MODEL = "gpt-5-mini";
export const SYNTHETIC_JUDGE_COST_USD = 0.0021;
export const SYNTHETIC_RUBRIC =
  "Pass when the answer addresses the question and every claim is supported by the gold points. Fail when it contradicts them. Say uncertain when you cannot tell.";

const PROBE_PACKS_USED = ["generic", "llm_app"];
const PROBES_PER_STEP = 2;
const UNCERTAIN_CONFIDENCE_FLOOR = 0.4;
const UNCERTAIN_CONFIDENCE_SPAN = 0.2;
const DECIDED_MARGIN = 0.03;
const DECIDED_SPAN = 0.15;
const DECIDED_CEILING = 0.99;
const YES_RATE = 0.75;
const LATENCY_FLOOR_MS = 60;
const LATENCY_CEILING_MS = 320;
const JUDGE_CONFIDENCE_FLOOR = 0.78;
const JUDGE_CONFIDENCE_SPAN = 0.17;
const TIER_RANK: Record<VerdictTier, number> = { code: 0, laya: 1, judge: 2, human: 3 };

export interface StepGrade {
  verdict: Verdict;
  escalatedTo: VerdictTier | null;
  probes?: ProbeResult[];
  judge?: JudgeResult;
  evidence?: EvidenceBlock;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
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

const GENERIC_BANK: readonly Probe[] = buildProbeBank().filter((probe) =>
  PROBE_PACKS_USED.includes(probe.pack),
);

function pickProbes(step: Step, bank: readonly Probe[]): Probe[] {
  const first = stableInt(0, bank.length - 1, step.id, "first");
  const second = (first + 1 + stableInt(0, bank.length - 2, step.id, "second")) % bank.length;
  return [first, second].slice(0, PROBES_PER_STEP).flatMap((index) => {
    const probe = bank[index];
    return probe === undefined ? [] : [probe];
  });
}

function probeAnswer(step: Step, probe: Probe): string {
  if (probe.answer_type === "choice") {
    return "polite";
  }
  return stableUnit(step.id, probe.id, "answer") < YES_RATE ? "yes" : "no";
}

function buildProbeResult(step: Step, probe: Probe, uncertain: boolean): ProbeResult {
  const unit = stableUnit(step.id, probe.id, "confidence");
  const confidence = uncertain
    ? round(UNCERTAIN_CONFIDENCE_FLOOR + unit * UNCERTAIN_CONFIDENCE_SPAN, 2)
    : round(Math.min(DECIDED_CEILING, probe.threshold + DECIDED_MARGIN + unit * DECIDED_SPAN), 2);
  return {
    id: stableId("probe_result", step.id, probe.id),
    probe_id: probe.id,
    pack: probe.pack,
    question: probe.question,
    answer: probeAnswer(step, probe),
    status: uncertain ? "uncertain" : "decided",
    confidence,
    threshold: probe.threshold,
    latency_ms: stableInt(LATENCY_FLOOR_MS, LATENCY_CEILING_MS, step.id, probe.id, "latency"),
    probe_bank_version: PROBE_BANK_VERSION,
    engine: "laya",
  };
}

function goldPointsOf(step: Step): EvidenceGoldPoint[] {
  return step.gold_points.map((point) => ({
    key: point.key,
    rendered: point.rendered,
    value: point.value,
  }));
}

function buildJudge(step: Step): { judge: JudgeResult; evidence: EvidenceBlock } {
  const gold = goldPointsOf(step);
  const confidence = round(
    JUDGE_CONFIDENCE_FLOOR + stableUnit(step.id, "judge") * JUDGE_CONFIDENCE_SPAN,
    2,
  );
  const judge: JudgeResult = {
    id: stableId("judge_result", step.id),
    family: "openai",
    model: SYNTHETIC_JUDGE_MODEL,
    effort: "low",
    rubric_version: "judge-rubric.v1",
    verdict: verdictOf(
      "pass",
      "judge",
      confidence,
      "judge_pass",
      "The answer addresses the question and no claim was unsupported",
    ),
    pairwise: { swapped_agrees: true },
    evidence: { gold_points: gold, must_not_claim: [], unsupported_claims: [] },
    cost_usd: SYNTHETIC_JUDGE_COST_USD,
  };
  const evidence: EvidenceBlock = {
    ask: step.ask,
    answer: step.answer,
    gold_points: gold,
    invariants: [],
    must_not_claim: [],
    rubric: SYNTHETIC_RUBRIC,
    unsupported_claim_candidates: [],
  };
  return { judge, evidence };
}

export function escalationOf(
  step: Pick<Step, "probes" | "judge" | "verdict">,
): VerdictTier | null {
  if (step.verdict?.tier === "human") {
    return "human";
  }
  if (step.judge !== null) {
    return "judge";
  }
  return step.probes.length > 0 ? "laya" : null;
}

function gradeGeneric(step: Step, ok: boolean): StepGrade {
  if (!step.tier0.passed) {
    return {
      verdict: verdictOf(
        "fail",
        "code",
        1,
        "tier0_failed",
        step.tier0.failures[0]?.message ?? null,
      ),
      escalatedTo: null,
    };
  }
  if (!ok) {
    return {
      verdict: verdictOf(
        "fail",
        "code",
        1,
        "step_not_completed",
        "The adapter did not complete the step",
      ),
      escalatedTo: null,
    };
  }
  if (step.answer === null) {
    return { verdict: verdictOf("pass", "code", 1, "tier0_passed", null), escalatedTo: null };
  }
  const escalate = stableUnit(step.id, "escalate") < ESCALATION_RATE;
  const probes = pickProbes(step, GENERIC_BANK).map((probe, position) =>
    buildProbeResult(step, probe, escalate && position === 0),
  );
  if (escalate) {
    const { judge, evidence } = buildJudge(step);
    return { verdict: judge.verdict, escalatedTo: "judge", probes, judge, evidence };
  }
  const confidence = Math.min(...probes.map((probe) => probe.confidence));
  return {
    verdict: verdictOf(
      "pass",
      "laya",
      probes.length === 0 ? null : confidence,
      "probes_decided",
      `Laya decided ${probes.length} probes at or above their thresholds`,
    ),
    escalatedTo: "laya",
    probes,
  };
}

export function gradeStep(step: Step, ok: boolean | null): StepGrade | null {
  if (step.verdict !== null) {
    return { verdict: step.verdict, escalatedTo: escalationOf(step) };
  }
  return ok === null ? null : gradeGeneric(step, ok);
}

function highestOf(verdicts: readonly Verdict[]): Verdict | undefined {
  return verdicts.reduce<Verdict | undefined>(
    (best, verdict) =>
      best === undefined || TIER_RANK[verdict.tier] > TIER_RANK[best.tier] ? verdict : best,
    undefined,
  );
}

function minConfidence(verdicts: readonly Verdict[]): number | null {
  const values = verdicts.flatMap((verdict) =>
    verdict.confidence === null ? [] : [verdict.confidence],
  );
  return values.length === 0 ? null : Math.min(...values);
}

export function resolveAttemptVerdict(
  steps: readonly Pick<Step, "verdict">[],
  defaultVerdict: Verdict,
): Verdict | null {
  const graded = steps.flatMap((step) => (step.verdict === null ? [] : [step.verdict]));
  const higher = graded.filter((verdict) => verdict.tier !== "code");
  if (higher.length === 0) {
    return null;
  }
  const higherFail = higher.find((verdict) => verdict.status === "fail");
  if (defaultVerdict.status === "fail") {
    const codeFail = graded.some((verdict) => verdict.tier === "code" && verdict.status === "fail");
    return codeFail || higherFail === undefined ? null : { ...higherFail };
  }
  if (defaultVerdict.status !== "pass") {
    return null;
  }
  if (higherFail !== undefined) {
    return { ...higherFail };
  }
  const higherUncertain = higher.find((verdict) => verdict.status === "uncertain");
  if (higherUncertain !== undefined) {
    return { ...higherUncertain };
  }
  const decider = highestOf(higher);
  if (decider === undefined) {
    return null;
  }
  return { ...decider, status: "pass", confidence: minConfidence(graded) };
}
