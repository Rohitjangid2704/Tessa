import type { FilterOption } from "@/components/filter-bar";
import type { RunStatus, VerdictStatus } from "@/components/status/status-types";
import type { RunKind, RunScenarioStatus } from "@/lib/api/types";

export const RUN_KINDS = [
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
] as const satisfies readonly RunKind[];

export const RUN_KIND_LABELS = {
  suite: "Suite",
  seed: "Seed",
  generate: "Generate",
  explore: "Explore",
  simulate: "Simulate",
  redteam: "Red team",
  replay: "Replay",
  mutation: "Mutation",
  contract: "Contract",
  import: "Import",
  calibration: "Calibration",
  hello: "Hello",
} as const satisfies Record<RunKind, string>;

export const RUN_STATUS_LABELS = {
  queued: "Queued",
  planning: "Planning",
  seeding: "Seeding",
  running: "Running",
  canceling: "Canceling",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
  budget_exceeded: "Budget exceeded",
} as const satisfies Record<RunStatus, string>;

export const RUN_SCENARIO_STATUSES = [
  "queued",
  "running",
  "finished",
  "skipped",
  "errored",
  "canceled",
] as const satisfies readonly RunScenarioStatus[];

export const RUN_SCENARIO_STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  finished: "Finished",
  skipped: "Skipped",
  errored: "Errored",
  canceled: "Canceled",
} as const satisfies Record<RunScenarioStatus, string>;

export const VERDICT_LABELS = {
  pass: "Pass",
  fail: "Fail",
  flaky: "Flaky",
  uncertain: "Uncertain",
  skipped: "Skipped",
} as const satisfies Record<VerdictStatus, string>;

export function filterOptions<Value extends string>(
  values: readonly Value[],
  labels: Record<Value, string>,
): FilterOption[] {
  return values.map((value) => ({ value, label: labels[value] }));
}

export function textFilterOptions(
  known: readonly string[] | undefined,
  selected: readonly string[] | undefined,
): FilterOption[] {
  const values = [...new Set([...(known ?? []), ...(selected ?? [])])];
  return values
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ value, label: value }));
}
