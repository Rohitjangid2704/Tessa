import type { RunEntry } from "../stage2/store";
import type {
  RunDiff,
  RunDiffCategory,
  RunDiffItem,
  RunScenario,
  Verdict,
  VerdictStatus,
} from "@/lib/api/types";
import { buildRunStats } from "./stats";

const COST_DIGITS = 6;

const COMPARABLE_CATEGORIES: readonly RunDiffCategory[] = [
  "new_failure",
  "fixed",
  "still_failing",
  "flaky_change",
  "unchanged",
];

function itemKey(row: Pick<RunScenario, "scenario_id" | "role" | "interface_id">): string {
  return `${row.scenario_id}|${row.role}|${row.interface_id}`;
}

function decidedStatus(verdict: Verdict | null): VerdictStatus | null {
  return verdict === null || verdict.status === "skipped" ? null : verdict.status;
}

export function classifyChange(
  before: Verdict | null,
  after: Verdict | null,
  presentBefore: boolean,
  presentAfter: boolean,
): RunDiffCategory {
  if (!presentBefore) {
    return "added";
  }
  if (!presentAfter) {
    return "removed";
  }
  const previous = decidedStatus(before);
  const current = decidedStatus(after);
  if (previous === null || current === null) {
    return "not_comparable";
  }
  if (previous === "uncertain" || current === "uncertain") {
    return previous === current ? "unchanged" : "not_comparable";
  }
  if (previous === "fail" && current === "fail") {
    return "still_failing";
  }
  if (previous === current) {
    return "unchanged";
  }
  if (previous === "flaky" || current === "flaky") {
    return "flaky_change";
  }
  return previous === "pass" ? "new_failure" : "fixed";
}

function listOf(items: readonly RunDiffItem[], category: RunDiffCategory): string[] {
  return [
    ...new Set(
      items
        .filter((item) => item.comparable && item.category === category)
        .map((item) => item.scenario_id),
    ),
  ];
}

export interface DiffSide {
  entry: RunEntry;
  rows: readonly RunScenario[];
  openFindings: number;
}

export function buildRunDiff(current: DiffSide, against: DiffSide): RunDiff {
  const afterByKey = new Map(current.rows.map((row) => [itemKey(row), row]));
  const beforeByKey = new Map(against.rows.map((row) => [itemKey(row), row]));
  const keys = [...new Set([...afterByKey.keys(), ...beforeByKey.keys()])];
  const items = keys.map((key): RunDiffItem => {
    const after = afterByKey.get(key);
    const before = beforeByKey.get(key);
    const source = after ?? before;
    if (source === undefined) {
      throw new Error(`no scenario row for ${key}`);
    }
    const category = classifyChange(
      before?.verdict ?? null,
      after?.verdict ?? null,
      before !== undefined,
      after !== undefined,
    );
    return {
      scenario_id: source.scenario_id,
      title: source.title,
      family: source.family,
      role: source.role,
      interface_id: source.interface_id,
      run_scenario_id: after?.id ?? null,
      against_run_scenario_id: before?.id ?? null,
      before: before?.verdict ? { ...before.verdict } : null,
      after: after?.verdict ? { ...after.verdict } : null,
      comparable: COMPARABLE_CATEGORIES.includes(category),
      category,
    };
  });
  const currentStats = buildRunStats(current.entry, current.rows, current.openFindings);
  const againstStats = buildRunStats(against.entry, against.rows, against.openFindings);
  return {
    new_failures: listOf(items, "new_failure"),
    fixed: listOf(items, "fixed"),
    still_failing: listOf(items, "still_failing"),
    flaky_changes: listOf(items, "flaky_change"),
    cost_delta_usd: Number(
      (currentStats.cost_usd.total - againstStats.cost_usd.total).toFixed(COST_DIGITS),
    ),
    latency_p50_delta_ms: currentStats.latency_ms.p50 - againstStats.latency_ms.p50,
    items,
  };
}
