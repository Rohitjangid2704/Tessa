import type { JudgeFamily, JudgeResult, Step, Verdict, VerdictTier } from "@/lib/api/types";
import { formatLatency } from "./format";
import { describeProbeSummary, summarizeProbes } from "./probe-model";

export const STUB_MODEL_NAME = "stub";
export const STUB_REASON_CODE = "stub_model";

export const JUDGE_FAMILY_LABELS: Record<JudgeFamily, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

export const LADDER_TIERS = [
  "code",
  "laya",
  "judge",
  "human",
] as const satisfies readonly VerdictTier[];

const TIER_RANK: Record<VerdictTier, number> = { code: 0, laya: 1, judge: 2, human: 3 };

export const LADDER_HEADINGS: Record<VerdictTier, string> = {
  code: "Code checks",
  laya: "Laya probes",
  judge: "LLM judge",
  human: "Human review",
};

export type RungOutcome =
  | "decided"
  | "handed_on"
  | "not_needed"
  | "not_run"
  | "awaiting_label"
  | "pending";

export const RUNG_OUTCOME_LABELS: Record<RungOutcome, string> = {
  decided: "Produced the verdict",
  handed_on: "Ran, did not decide",
  not_needed: "Not needed",
  not_run: "Did not run",
  awaiting_label: "Needs a label",
  pending: "Waiting",
};

export interface LadderRung {
  tier: VerdictTier;
  heading: string;
  outcome: RungOutcome;
  detail: string;
}

export interface TierLadderModel {
  graded: boolean;
  rungs: LadderRung[];
  verdict: Verdict | null;
  decidedBy: VerdictTier | null;
  highestTier: VerdictTier | null;
  escalatedTo: VerdictTier | null;
  reasons: string[];
  needsHuman: boolean;
  stub: boolean;
}

export function isStubJudge(judge: Pick<JudgeResult, "model" | "verdict">): boolean {
  return judge.model === STUB_MODEL_NAME || judge.verdict.reason_code === STUB_REASON_CODE;
}

export function isStubStep(step: Pick<Step, "judge" | "verdict">): boolean {
  return (
    (step.judge !== null && isStubJudge(step.judge)) ||
    step.verdict?.reason_code === STUB_REASON_CODE
  );
}

export function judgeUsedTiebreak(judge: Pick<JudgeResult, "pairwise" | "verdict">): boolean {
  return judge.pairwise?.swapped_agrees === false && judge.verdict.status !== "uncertain";
}

export function highestTierReached(
  step: Pick<Step, "verdict" | "judge" | "probes">,
): VerdictTier | null {
  const reached: VerdictTier[] = [];
  if (step.verdict !== null) {
    reached.push(step.verdict.tier, "code");
  }
  if (step.probes.length > 0) {
    reached.push("laya");
  }
  if (step.judge !== null) {
    reached.push("judge");
  }
  return reached.reduce<VerdictTier | null>(
    (highest, tier) => (highest === null || TIER_RANK[tier] > TIER_RANK[highest] ? tier : highest),
    null,
  );
}

export function escalatedTo(
  step: Pick<Step, "verdict" | "judge" | "probes">,
): VerdictTier | null {
  const highest = highestTierReached(step);
  return highest === "code" ? null : highest;
}

export type JudgeSection = "ran" | "not_needed" | "did_not_run" | "absent";

export function judgeSection(step: Pick<Step, "judge" | "verdict" | "probes">): JudgeSection {
  if (step.judge !== null) {
    return "ran";
  }
  if (step.verdict === null || step.probes.length === 0) {
    return "absent";
  }
  return summarizeProbes(step.probes).unresolved === 0 ? "not_needed" : "did_not_run";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describePairwise(judge: JudgeResult): string {
  if (judge.pairwise === null) {
    return "single pass, no reference order to swap";
  }
  return judge.pairwise.swapped_agrees
    ? "both presentation orders agreed"
    : "the swapped orders disagreed";
}

function describeCode(step: Step): string {
  if (step.tier0.passed) {
    return "All tier 0 checks passed.";
  }
  const checks = [...new Set(step.tier0.failures.map((failure) => failure.check))];
  return `${plural(step.tier0.failures.length, "check")} failed: ${checks.join(", ")}.`;
}

function describeJudge(judge: JudgeResult): string {
  const stub = isStubJudge(judge) ? " Stub model, no provider was called." : "";
  return `${JUDGE_FAMILY_LABELS[judge.family]} ${judge.model}, effort ${judge.effort}; ${describePairwise(judge)}.${stub}`;
}

function idleDetail(
  tier: VerdictTier,
  outcome: RungOutcome,
  decidedBy: VerdictTier | null,
): string {
  if (outcome === "pending") {
    return "Waiting for the grade.";
  }
  if (outcome === "awaiting_label") {
    return "A label task was created. The step stays uncertain until a person labels it.";
  }
  if (tier === "human") {
    return "No human review was needed.";
  }
  if (outcome === "not_needed") {
    return decidedBy === "code"
      ? "Not needed: tier 0 decided alone."
      : "Not needed: the earlier tier decided.";
  }
  if (tier === "laya") {
    return "No probe results were stored for this step.";
  }
  return "The judge did not run, so the step was not escalated past the earlier tier.";
}

function rungOutcome(
  tier: VerdictTier,
  decidedBy: VerdictTier | null,
  ran: boolean,
  uncertainWithoutHuman: boolean,
): RungOutcome {
  if (decidedBy === null) {
    return ran && tier !== "code" ? "handed_on" : "pending";
  }
  if (decidedBy === tier) {
    return "decided";
  }
  if (TIER_RANK[tier] < TIER_RANK[decidedBy]) {
    return ran ? "handed_on" : "not_run";
  }
  if (tier === "human") {
    return uncertainWithoutHuman ? "awaiting_label" : "not_needed";
  }
  if (ran) {
    return "handed_on";
  }
  return uncertainWithoutHuman ? "not_run" : "not_needed";
}

function rungDetail(
  step: Step,
  tier: VerdictTier,
  outcome: RungOutcome,
  decidedBy: VerdictTier | null,
): string {
  if (tier === "code") {
    return describeCode(step);
  }
  if (tier === "laya" && step.probes.length > 0) {
    const summary = summarizeProbes(step.probes);
    return `${describeProbeSummary(summary)}; ${formatLatency(summary.latencyMs)} in total, $0.00.`;
  }
  if (tier === "judge" && step.judge !== null) {
    return describeJudge(step.judge);
  }
  if (tier === "human" && outcome === "decided" && step.verdict !== null) {
    return `A person set the verdict to ${step.verdict.status}.`;
  }
  return idleDetail(tier, outcome, decidedBy);
}

function describeEscalationReasons(step: Step, needsHuman: boolean): string[] {
  const reasons: string[] = [];
  const verdict = step.verdict;
  const probes = summarizeProbes(step.probes);
  if (verdict === null) {
    return reasons;
  }
  if (!step.tier0.passed) {
    reasons.push("Tier 0 found failing checks, which already settles the step: nothing escalated.");
  } else if (probes.total > 0) {
    reasons.push("Tier 0 passed, so the Laya probes ran.");
  }
  const judge = step.judge;
  if (judge !== null) {
    const causes: string[] = [];
    if (probes.uncertain > 0) {
      causes.push(`${plural(probes.uncertain, "probe")} uncertain`);
    }
    if (probes.belowThreshold > 0) {
      causes.push(`${plural(probes.belowThreshold, "probe")} below the threshold`);
    }
    if (probes.errored > 0) {
      causes.push(`${plural(probes.errored, "probe")} failed`);
    }
    reasons.push(
      causes.length > 0
        ? `Escalated to the judge: ${causes.join(", ")}.`
        : "The judge ran although the probes decided everything (an audit or a policy).",
    );
    if (judge.pairwise?.swapped_agrees === false) {
      reasons.push(
        judgeUsedTiebreak(judge)
          ? `The position-swapped judge pair disagreed, so the tie-break model (${JUDGE_FAMILY_LABELS[judge.family]} ${judge.model}) decided.`
          : "The position-swapped judge pair disagreed and no tie-break settled it, so the verdict is uncertain.",
      );
    }
  } else if (probes.total > 0 && probes.unresolved === 0) {
    reasons.push("Every probe was decided, so the judge was not needed.");
  } else if (probes.total > 0) {
    reasons.push(
      `The judge did not run although ${plural(probes.unresolved, "probe")} stayed unresolved.`,
    );
  } else if (step.tier0.passed) {
    reasons.push("Tier 0 decided alone; no probe applies to this step.");
  }
  if (needsHuman) {
    reasons.push("The machine graders could not settle it, so a label task was created.");
  }
  if (verdict.tier === "human") {
    reasons.push("A person set the verdict, which replaces the machine verdict.");
  }
  return reasons;
}

export function buildTierLadder(step: Step): TierLadderModel {
  const verdict = step.verdict;
  const decidedBy = verdict?.tier ?? null;
  const needsHuman = verdict !== null && verdict.status === "uncertain" && verdict.tier !== "human";
  const ranByTier: Record<VerdictTier, boolean> = {
    code: true,
    laya: step.probes.length > 0,
    judge: step.judge !== null,
    human: verdict?.tier === "human",
  };
  const rungs = LADDER_TIERS.map((tier): LadderRung => {
    const outcome = rungOutcome(tier, decidedBy, ranByTier[tier], needsHuman);
    return {
      tier,
      heading: LADDER_HEADINGS[tier],
      outcome,
      detail: rungDetail(step, tier, outcome, decidedBy),
    };
  });
  return {
    graded: verdict !== null,
    rungs,
    verdict,
    decidedBy,
    highestTier: highestTierReached(step),
    escalatedTo: escalatedTo(step),
    reasons: describeEscalationReasons(step, needsHuman),
    needsHuman,
    stub: isStubStep(step),
  };
}
