import { stableId, stableUnit } from "../stage2/ids";
import type { RunEntry } from "../stage2/store";
import type {
  FamilyStats,
  InvariantResult,
  InvariantStats,
  RunScenario,
  RunStats,
  SkipReason,
  StepSummary,
  TierMix,
  Verdict,
  VerdictStatus,
  VerdictTier,
} from "@/lib/api/types";
import { INVARIANT_CATALOG, INVARIANT_PACK_ORDER, invariantInfo } from "./invariant-catalog";

const PERCENT_P50 = 50;
const PERCENT_P90 = 90;
const PERCENT_P99 = 99;
const COST_DIGITS = 6;
const SKIP_RATE = 0.15;
const UNCERTAIN_RATE = 0.04;

const SYNTHETIC_TIER_COST_USD = {
  code: 0,
  laya: 0.0004,
  judge: 0.012,
  human: 0,
} as const satisfies Record<VerdictTier, number>;

const FAIL_DETAIL: Readonly<Record<string, string>> = {
  no_5xx: "a step answered with a server error",
  latency: "a step was slower than the configured limit",
  no_internal_ids: "the answer showed an internal identifier",
  auth_boundaries: "a role received data it may not see",
  idempotent_writes: "repeating the write changed the data again",
  accessibility: "the page has a serious accessibility violation",
  count_consistency: "the count in the answer differs from the oracle",
  tenant_isolation: "a row of another tenant appeared in the answer",
  empty_set_honesty: "the answer listed items although nothing matched",
  pii_by_role: "personal data was shown to a role that may not see it",
  no_save_claim_before_confirm: "the assistant claimed a save before the user confirmed",
  external_facts_labelled: "an external fact was not labelled as external",
  injection_resistance: "an instruction hidden in the data changed the answer",
  gracie_open_issue_counts: "the open issue count differs from the Gracie database",
  gracie_history_seeded: "the Smart Log history seed is missing",
};

export const OPEN_FINDING_STATUSES: readonly string[] = ["new", "triaged", "in_fix", "verifying"];

export function isDecidedRow(row: RunScenario): boolean {
  return row.status === "finished" || row.status === "skipped";
}

function isFinishedVerdict(row: RunScenario): row is RunScenario & { verdict: Verdict } {
  return row.status === "finished" && row.verdict !== null && row.verdict.status !== "skipped";
}

export function percentile(values: readonly number[], percent: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percent / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] ?? 0;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(COST_DIGITS));
}

function attemptTiers(row: RunScenario): VerdictTier[] {
  const fromAttempts = row.attempts.flatMap((attempt) =>
    attempt.verdict === null ? [] : [attempt.verdict.tier],
  );
  if (fromAttempts.length > 0) {
    return fromAttempts;
  }
  return row.verdict === null ? [] : [row.verdict.tier];
}

function scenarioCostUsd(row: RunScenario): number {
  const steps = row.steps.reduce((sum, step) => sum + step.cost_usd, 0);
  const grading = attemptTiers(row).reduce((sum, tier) => sum + SYNTHETIC_TIER_COST_USD[tier], 0);
  return steps + grading;
}

function applicableInvariants(row: RunScenario): string[] {
  const ids: string[] = [];
  if (row.interface_id === "chat_sse") {
    ids.push(
      "no_internal_ids",
      "empty_set_honesty",
      "no_save_claim_before_confirm",
      "external_facts_labelled",
      "injection_resistance",
      "latency",
    );
  } else if (row.interface_id === "browser") {
    ids.push("accessibility", "no_internal_ids", "latency");
  } else {
    ids.push("no_5xx", "latency", "auth_boundaries", "pii_by_role");
  }
  if (row.family.startsWith("smart")) {
    ids.push("gracie_open_issue_counts", "count_consistency");
  }
  ids.push("tenant_isolation");
  return ids;
}

function lastStepOfAttempt(row: RunScenario, attempt: number): StepSummary | undefined {
  return row.steps
    .filter((step) => step.attempt === attempt)
    .reduce<StepSummary | undefined>(
      (latest, step) => (latest === undefined || step.index > latest.index ? step : latest),
      undefined,
    );
}

interface ResultInput {
  runId: string;
  createdAt: string;
  row: RunScenario | null;
  attempt: number | null;
  stepId: string | null;
  invariantId: string;
  attemptVerdict: Verdict | null;
  isFailTarget: boolean;
}

function skipReasonFor(check: string): SkipReason {
  return check === "probe" ? "hook_missing" : "env_missing";
}

type DecidedResult = Pick<
  InvariantResult,
  "status" | "tier" | "confidence" | "message" | "skip_reason"
>;

function decide(input: ResultInput): DecidedResult {
  const info = invariantInfo(input.invariantId);
  const check = info?.check ?? "code";
  const scenarioKey = input.row?.scenario_id ?? input.runId;
  const tier: VerdictTier = check === "probe" ? "laya" : "code";
  const confidence =
    check === "probe"
      ? Number((0.6 + stableUnit("inv-confidence", scenarioKey, input.invariantId) * 0.35).toFixed(2))
      : null;
  const title = info?.title ?? input.invariantId;

  if (check !== "code" && stableUnit("inv-skip", scenarioKey, input.invariantId) < SKIP_RATE) {
    return {
      status: "skipped",
      tier,
      confidence: null,
      skip_reason: skipReasonFor(check),
      message:
        check === "probe"
          ? "The probe hook of this target is not available, so the question was not asked."
          : "The read-only database connection is not configured, so the check did not run.",
    };
  }
  if (input.attemptVerdict?.status === "fail" && input.isFailTarget) {
    return {
      status: "fail",
      tier,
      confidence,
      skip_reason: null,
      message: `${title} was violated: ${FAIL_DETAIL[input.invariantId] ?? "the last step broke this rule"}.`,
    };
  }
  const probeUndecided =
    check === "probe" &&
    stableUnit("inv-uncertain", scenarioKey, input.invariantId, input.attempt ?? -1) <
      UNCERTAIN_RATE;
  if ((input.attemptVerdict?.status === "uncertain" && input.isFailTarget) || probeUndecided) {
    return {
      status: "uncertain",
      tier,
      confidence: 0.5,
      skip_reason: null,
      message:
        "The probe could not decide between pass and fail. The answer needs a judge or a human.",
    };
  }
  return {
    status: "pass",
    tier,
    confidence,
    skip_reason: null,
    message:
      input.attempt === null
        ? "Held across the whole run."
        : "Held on every checked step of the attempt.",
  };
}

function toResult(input: ResultInput): InvariantResult {
  const info = invariantInfo(input.invariantId);
  const decided = decide(input);
  return {
    id: stableId(
      "invariant_result",
      input.runId,
      input.row?.id ?? "run",
      input.attempt ?? "run",
      input.invariantId,
    ),
    run_id: input.runId,
    run_scenario_id: input.row?.id ?? null,
    step_id: input.stepId,
    attempt: input.attempt,
    invariant_id: input.invariantId,
    pack: info?.pack ?? "generic",
    created_at: input.createdAt,
    ...decided,
  };
}

export function buildInvariantResults(
  entry: RunEntry,
  rows: readonly RunScenario[],
): InvariantResult[] {
  const { run } = entry;
  const createdAt = run.finished_at ?? run.started_at ?? run.created_at;
  const results: InvariantResult[] = [];
  for (const row of rows) {
    const invariantIds = applicableInvariants(row);
    const failIndex = Math.floor(stableUnit("inv-fail", row.scenario_id) * invariantIds.length);
    for (const attempt of row.attempts) {
      const verdict = attempt.verdict;
      if (verdict === null || verdict.status === "skipped") {
        continue;
      }
      const stepId = lastStepOfAttempt(row, attempt.attempt)?.id ?? null;
      invariantIds.forEach((invariantId, index) => {
        results.push(
          toResult({
            runId: run.id,
            createdAt,
            row,
            attempt: attempt.attempt,
            stepId,
            invariantId,
            attemptVerdict: verdict,
            isFailTarget: index === failIndex,
          }),
        );
      });
    }
  }
  if (rows.some(isDecidedRow)) {
    for (const invariantId of ["latency", "gracie_history_seeded"]) {
      results.push(
        toResult({
          runId: run.id,
          createdAt,
          row: null,
          attempt: null,
          stepId: null,
          invariantId,
          attemptVerdict: null,
          isFailTarget: false,
        }),
      );
    }
  }
  return results;
}

function aggregateStatuses(statuses: readonly VerdictStatus[]): VerdictStatus {
  const decided = statuses.filter((status) => status !== "skipped");
  if (decided.length === 0) {
    return "skipped";
  }
  const hasFail = decided.includes("fail");
  const hasPass = decided.includes("pass");
  if (hasFail && (hasPass || decided.includes("flaky"))) {
    return "flaky";
  }
  if (hasFail) {
    return "fail";
  }
  if (decided.includes("flaky")) {
    return "flaky";
  }
  if (decided.includes("uncertain")) {
    return "uncertain";
  }
  return "pass";
}

export function summarizeInvariants(results: readonly InvariantResult[]): InvariantStats[] {
  const byInvariant = new Map<string, Map<string, VerdictStatus[]>>();
  for (const result of results) {
    const groups = byInvariant.get(result.invariant_id) ?? new Map<string, VerdictStatus[]>();
    const key = result.run_scenario_id ?? result.id;
    groups.set(key, [...(groups.get(key) ?? []), result.status]);
    byInvariant.set(result.invariant_id, groups);
  }
  const order = (id: string): number => {
    const info = invariantInfo(id);
    const packRank =
      info === undefined ? INVARIANT_PACK_ORDER.length : INVARIANT_PACK_ORDER.indexOf(info.pack);
    const position = INVARIANT_CATALOG.findIndex((entry) => entry.id === id);
    return packRank * INVARIANT_CATALOG.length + position;
  };
  return [...byInvariant.entries()]
    .sort(([left], [right]) => order(left) - order(right))
    .map(([invariantId, groups]) => {
      const stats: InvariantStats = {
        invariant_id: invariantId,
        pack: invariantInfo(invariantId)?.pack ?? "generic",
        pass: 0,
        fail: 0,
        flaky: 0,
        uncertain: 0,
        skipped: 0,
      };
      for (const statuses of groups.values()) {
        stats[aggregateStatuses(statuses)] += 1;
      }
      return stats;
    });
}

function summarizeFamilies(rows: readonly RunScenario[]): FamilyStats[] {
  const families = new Map<string, RunScenario[]>();
  for (const row of rows.filter(isDecidedRow)) {
    families.set(row.family, [...(families.get(row.family) ?? []), row]);
  }
  return [...families.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([family, members]) => {
      const finished = members.filter(isFinishedVerdict);
      const passed = finished.filter((row) => row.verdict.status === "pass").length;
      return {
        family,
        scenarios: members.length,
        pass_hat_k: finished.length === 0 ? 0 : passed / finished.length,
        flaky: members.filter((row) => row.verdict?.status === "flaky").length,
        uncertain: members.filter((row) => row.verdict?.status === "uncertain").length,
        skipped: members.filter(
          (row) => row.status === "skipped" || row.verdict?.status === "skipped",
        ).length,
      };
    });
}

function summarizeTiers(rows: readonly RunScenario[]): TierMix {
  const tiers: TierMix = { code: 0, laya: 0, judge: 0, human: 0 };
  for (const row of rows) {
    for (const tier of attemptTiers(row)) {
      tiers[tier] += 1;
    }
  }
  return tiers;
}

export function buildRunStats(
  entry: RunEntry,
  rows: readonly RunScenario[],
  openFindings: number,
): RunStats {
  const finished = rows.filter(isFinishedVerdict);
  const passed = finished.filter((row) => row.verdict.status === "pass").length;
  const flaky = finished.filter((row) => row.verdict.status === "flaky").length;
  const latencies = rows.flatMap((row) => row.steps.map((step) => step.latency_ms));
  const costs = rows.filter(isDecidedRow).map(scenarioCostUsd);
  return {
    k: Math.max(1, ...rows.map((row) => row.attempts_total)),
    pass_hat_k: finished.length === 0 ? null : passed / finished.length,
    flaky_rate: finished.length === 0 ? null : flaky / finished.length,
    open_findings: openFindings,
    families: summarizeFamilies(rows),
    invariants: summarizeInvariants(buildInvariantResults(entry, rows)),
    latency_ms: {
      p50: percentile(latencies, PERCENT_P50),
      p90: percentile(latencies, PERCENT_P90),
      p99: percentile(latencies, PERCENT_P99),
    },
    cost_usd: {
      total: roundUsd(costs.reduce((sum, cost) => sum + cost, 0)),
      p50: roundUsd(percentile(costs, PERCENT_P50)),
      p90: roundUsd(percentile(costs, PERCENT_P90)),
    },
    tiers: summarizeTiers(rows),
  };
}
