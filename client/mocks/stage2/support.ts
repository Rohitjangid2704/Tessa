import { notFound } from "../factories/errors";
import type { QueryReader } from "../factories/pagination";
import type { ApiContext } from "../handlers/api";
import type { RunStatus } from "@/lib/api/types";
import type { RunEntry, StageTwoStore } from "./store";

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "completed",
  "failed",
  "canceled",
  "budget_exceeded",
];

export const RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "planning",
  "seeding",
  "running",
  "canceling",
  ...TERMINAL_STATUSES,
];

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
] as const;

export const SCENARIO_STATUSES = [
  "draft",
  "validating",
  "invalid",
  "in_review",
  "accepted",
  "rejected",
  "quarantined",
  "retired",
] as const;

export const SCENARIO_ORIGINS = [
  "bundle_example",
  "generated",
  "authored",
  "promoted_finding",
  "explorer",
  "replay",
  "manual",
] as const;

export const RUN_SCENARIO_STATUSES = [
  "queued",
  "running",
  "finished",
  "skipped",
  "errored",
  "canceled",
] as const;

export const VERDICT_STATUSES = ["pass", "fail", "flaky", "uncertain", "skipped"] as const;

export const CELL_STATUSES = ["empty", "generated", "covered", "needs_author", "blocked"] as const;

export const BROWSER_SESSION_STATUSES = ["active", "ended"] as const;

export function stageTwo(context: ApiContext): StageTwoStore {
  return context.state.stageTwo;
}

export function requireRunEntry(context: ApiContext, runId: string): RunEntry {
  const entry = stageTwo(context).findRun(runId);
  if (entry === undefined) {
    throw notFound("Run not found");
  }
  return entry;
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function queryDateTime(query: QueryReader, key: string): number | undefined {
  const raw = query.text(key);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    query.details.push({
      loc: ["query", key],
      code: "datetime_from_date_parsing",
      message: "Input should be a valid datetime or date, invalid datetime format",
    });
    return undefined;
  }
  return parsed;
}

export function nowIso(): string {
  return new Date().toISOString();
}
