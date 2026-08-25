import type { DashboardSummaryExtended, LastNightly } from "@/lib/api/types";
import type { ApiContext } from "../handlers/api";
import { liveProbes } from "../stage10/live-probes-store";
import { STAGE_ONE_IDS } from "../stage1/seed";
import type { RunEntry } from "../stage2/store";
import { stageTwo } from "../stage2/support";
import { toRunSummary } from "../stage2/views";
import { buildRunStats } from "../stage5/stats";
import { buildMutationSummary } from "./mutation-fixture";
import { stageEight } from "./store";

export const DASHBOARD_LAST_RUNS = 5;

export const COST_WEEK_USD = 18.4231;

function endedAtOf(entry: RunEntry): number {
  return Date.parse(entry.run.finished_at ?? entry.run.created_at);
}

function newestFirst(left: RunEntry, right: RunEntry): number {
  return Date.parse(right.run.created_at) - Date.parse(left.run.created_at);
}

function lastNightlyOf(context: ApiContext, candidates: readonly RunEntry[]): LastNightly | null {
  if (!stageEight.hasNightly) {
    return null;
  }
  const latest = candidates
    .filter((entry) => entry.run.kind === "suite" && entry.run.status === "completed")
    .sort((left, right) => endedAtOf(right) - endedAtOf(left))[0];
  if (latest === undefined) {
    return null;
  }
  const rows = stageTwo(context).scenariosOfRun(latest.run.id);
  return {
    run_id: latest.run.id,
    pass_hat_k: buildRunStats(latest, rows, 0).pass_hat_k,
    finished_at: latest.run.finished_at ?? latest.run.created_at,
  };
}

export function buildDashboardSummary(
  context: ApiContext,
  targetId: string | undefined,
): DashboardSummaryExtended {
  const candidates = stageTwo(context).runs.filter(
    (entry) => targetId === undefined || entry.run.target_id === targetId,
  );
  const summaryTarget = targetId ?? STAGE_ONE_IDS.gracie;
  const mutation = buildMutationSummary(summaryTarget, stageEight.mutationScenario);
  return {
    last_nightly: lastNightlyOf(context, candidates),
    open_findings_by_severity: { ...stageEight.severity },
    cost_week_usd: COST_WEEK_USD,
    suite_power: mutation.total === 0 ? null : mutation.suite_power,
    kappa: stageEight.kappa,
    last_runs: [...candidates].sort(newestFirst).slice(0, DASHBOARD_LAST_RUNS).map(toRunSummary),
    live_probes: liveProbes.read(),
  };
}
