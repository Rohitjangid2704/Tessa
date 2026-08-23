import type { CellStatus, Depth, VerdictStatus } from "./types";

export const CELL_STATUSES = [
  "empty",
  "generated",
  "covered",
  "needs_author",
  "blocked",
] as const satisfies readonly CellStatus[];

export const CELL_STATUS_LABELS = {
  empty: "Empty",
  generated: "Generated",
  covered: "Covered",
  needs_author: "Needs author",
  blocked: "Blocked",
} as const satisfies Record<CellStatus, string>;

export const CELL_STATUS_SHORT_LABELS = {
  empty: "Empty",
  generated: "Generated",
  covered: "Covered",
  needs_author: "Author",
  blocked: "Blocked",
} as const satisfies Record<CellStatus, string>;

export const CELL_STATUS_DESCRIPTIONS = {
  empty: "No scenario yet. Generate can fill it.",
  generated: "Scenarios exist and wait for review or a run.",
  covered: "A run has produced a verdict for this cell.",
  needs_author: "Needs a scenario written with Claude Code.",
  blocked: "Cannot run until the reason is fixed.",
} as const satisfies Record<CellStatus, string>;

export const VERDICT_LABELS = {
  pass: "Pass",
  fail: "Fail",
  flaky: "Flaky",
  uncertain: "Uncertain",
  skipped: "Skipped",
} as const satisfies Record<VerdictStatus, string>;

export const DEPTH_LABELS = {
  smoke: "Smoke",
  standard: "Standard",
  deep: "Deep",
} as const satisfies Record<Depth, string>;

export const DEPTH_HINTS = {
  smoke: "One scenario per cell, built from the bundle examples. Free, no model call.",
  standard: "Paraphrases and negative cases written by the model, then validated and dry-run.",
  deep: "The broadest set: adds role variants and adversarial cases. Costs the most.",
} as const satisfies Record<Depth, string>;

export const DEPTHS = ["smoke", "standard", "deep"] as const satisfies readonly Depth[];

export const BASELINE_PLAN_VALUE = "baseline";

export const BASELINE_PLAN_LABEL = "All features (baseline)";

export function isCellStatus(value: string): value is CellStatus {
  return (CELL_STATUSES as readonly string[]).includes(value);
}

export function isDepth(value: string): value is Depth {
  return (DEPTHS as readonly string[]).includes(value);
}
