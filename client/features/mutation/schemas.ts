import type { MutantStatus, MutationOutcome } from "./types";

export const MUTANT_SCHEMA_NAME = "mutant";
export const MUTANT_SCHEMA_VERSION = 1;
export const MUTANT_SCHEMA_STALE_TIME_MS = 60 * 60 * 1000;

export const MUTANT_PAGE_SIZE = 100;
export const RUN_HISTORY_PAGE_SIZE = 25;

export const INVARIANTS_WIDGET = "invariants";
export const MUTANTS_PROMPT_ANCHOR = "mutants-prompt";
export const MUTANT_ERROR_SCOPE = ["body"] as const;
export const MUTANTS_FILE_PATH = "tessa/mutants.yaml";

export const MUTANT_STATUSES: readonly MutantStatus[] = ["registered", "deployed", "retired"];

export const MUTANT_STATUS_LABELS: Readonly<Record<MutantStatus, string>> = {
  registered: "Registered",
  deployed: "Deployed",
  retired: "Retired",
};

export const MUTANT_STATUS_HELP: Readonly<Record<MutantStatus, string>> = {
  registered: "The branch exists but is not running on QA yet. A mutation run needs it deployed.",
  deployed: "The branch is running on QA at the base URL below, so a mutation run can test it.",
  retired: "The bug is no longer measured. It stays in the history but not in the suite power.",
};

export const MUTATION_OUTCOME_LABELS: Readonly<Record<MutationOutcome, string>> = {
  killed: "Killed",
  survived: "Survived",
  errored: "Errored",
  skipped: "Skipped",
};

export const MUTATION_OUTCOME_HELP: Readonly<Record<MutationOutcome, string>> = {
  killed: "At least one scenario failed on this invariant, so the suite noticed the bug.",
  survived: "No scenario failed on this invariant, so the suite missed the bug.",
  errored: "The invariant could not be scored because something broke while checking it.",
  skipped: "The invariant was not checked in this run.",
};

export const PRODUCTION_RUN_BLOCKED_REASON =
  "Mutation runs never run against a production target, because a mutant is a deliberately broken copy of the app. Pick a QA target.";

export const ARCHIVED_TARGET_REASON = "This target is archived, so nothing can be registered or run.";

export const NOT_DEPLOYED_REASON =
  "Deploy this branch to QA and mark the mutant deployed before running it.";

export const RETIRED_REASON = "This mutant is retired. Mark it registered or deployed to run it.";

export const NO_PLAN_REASON =
  "A mutation run needs a saved plan to run. Save a plan in the catalog first.";
