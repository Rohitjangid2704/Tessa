import type { KnownStreamEvent } from "@/features/streams/events";
import { isTerminalRunStatus } from "@/features/runs/run-status";
import type { JsonObject } from "@/lib/schema/subset";
import type { Target } from "@/features/targets/types";
import type { RunStatus } from "@/lib/api/types";
import {
  ARCHIVED_TARGET_REASON,
  NOT_DEPLOYED_REASON,
  PRODUCTION_RUN_BLOCKED_REASON,
  RETIRED_REASON,
} from "./schemas";
import type { Mutant, MutationOutcome, MutationOutcomeItem, MutantCreate, MutantUpdate } from "./types";

const PERCENT = 100;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;

export type TargetGuard = Pick<Target, "tier" | "archived_at">;

export interface RunBlock {
  short: string;
  reason: string;
}

export function mutantRunBlock(mutant: Mutant, target: TargetGuard): RunBlock | null {
  if (target.archived_at !== null && target.archived_at !== undefined) {
    return { short: "Target archived", reason: ARCHIVED_TARGET_REASON };
  }
  if (target.tier === "production") {
    return { short: "Never runs on production", reason: PRODUCTION_RUN_BLOCKED_REASON };
  }
  if (mutant.status === "retired") {
    return { short: "Retired", reason: RETIRED_REASON };
  }
  if (mutant.status === "registered") {
    return { short: "Not deployed yet", reason: NOT_DEPLOYED_REASON };
  }
  return null;
}

export type OutcomeCounts = Record<MutationOutcome, number>;

export function countOutcomes(outcomes: readonly MutationOutcomeItem[]): OutcomeCounts {
  const counts: OutcomeCounts = { killed: 0, survived: 0, errored: 0, skipped: 0 };
  for (const item of outcomes) {
    counts[item.outcome] += 1;
  }
  return counts;
}

export function describeOutcomeCounts(outcomes: readonly MutationOutcomeItem[]): string {
  if (outcomes.length === 0) {
    return "No outcome yet";
  }
  const counts = countOutcomes(outcomes);
  const parts = (["killed", "survived", "errored", "skipped"] as const)
    .filter((outcome) => counts[outcome] > 0)
    .map((outcome) => `${counts[outcome]} ${outcome}`);
  return parts.join(", ");
}

export function formatPower(power: number | null | undefined): string {
  if (power === null || power === undefined || !Number.isFinite(power)) {
    return "Not scored";
  }
  return `${Math.round(Math.min(1, Math.max(0, power)) * PERCENT)}% killed`;
}

export function isActiveRunStatus(status: RunStatus): boolean {
  return !isTerminalRunStatus(status);
}

export function elapsedSeconds(startedAt: string, finishedAt: string | null, now: number | null): number {
  const start = Date.parse(startedAt);
  const end = finishedAt === null ? now : Date.parse(finishedAt);
  if (Number.isNaN(start) || end === null || Number.isNaN(end)) {
    return 0;
  }
  return Math.max(0, Math.floor((end - start) / MILLISECONDS_PER_SECOND));
}

export function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return minutes === 0 ? `${seconds} s` : `${minutes} min ${String(seconds).padStart(2, "0")} s`;
}

export function mergeOutcomes(
  ...sources: readonly (readonly MutationOutcomeItem[])[]
): MutationOutcomeItem[] {
  const byInvariant = new Map<string, MutationOutcomeItem>();
  for (const source of sources) {
    for (const item of source) {
      byInvariant.set(item.invariant_id, item);
    }
  }
  return [...byInvariant.values()];
}

export function outcomesFromEvents(
  events: readonly KnownStreamEvent[],
  mutationRunId: string | null,
): MutationOutcomeItem[] {
  const items: MutationOutcomeItem[] = [];
  for (const event of events) {
    if (event.type !== "mutation.outcome") {
      continue;
    }
    if (mutationRunId !== null && event.payload.mutation_run_id !== mutationRunId) {
      continue;
    }
    items.push({
      invariant_id: event.payload.invariant_id,
      outcome: event.payload.outcome,
      caught_by: [...event.payload.caught_by],
    });
  }
  return mergeOutcomes(items);
}

export interface OutcomeRow {
  invariantId: string;
  outcome: MutationOutcomeItem | null;
}

export function outcomeRows(
  expected: readonly string[],
  outcomes: readonly MutationOutcomeItem[],
): OutcomeRow[] {
  const scored = new Map(outcomes.map((item) => [item.invariant_id, item]));
  const rows: OutcomeRow[] = expected.map((invariantId) => ({
    invariantId,
    outcome: scored.get(invariantId) ?? null,
  }));
  for (const item of outcomes) {
    if (!expected.includes(item.invariant_id)) {
      rows.push({ invariantId: item.invariant_id, outcome: item });
    }
  }
  return rows;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export interface MutantFields {
  name: string;
  branch: string;
  description: string;
  expectedCatchers: string[];
  baseUrl: string | null;
}

export function mutantFieldsOf(value: JsonObject): MutantFields {
  const baseUrl = textOf(value.base_url).trim();
  return {
    name: textOf(value.name),
    branch: textOf(value.branch),
    description: textOf(value.description),
    expectedCatchers: Array.isArray(value.expected_catchers)
      ? value.expected_catchers.filter((entry): entry is string => typeof entry === "string")
      : [],
    baseUrl: baseUrl === "" ? null : baseUrl,
  };
}

export function toMutantCreate(targetId: string, fields: MutantFields): MutantCreate {
  return {
    target_id: targetId,
    name: fields.name,
    branch: fields.branch,
    description: fields.description,
    expected_catchers: fields.expectedCatchers,
    ...(fields.baseUrl === null ? {} : { base_url: fields.baseUrl }),
  };
}

export function toMutantUpdate(fields: MutantFields): MutantUpdate {
  return {
    name: fields.name,
    branch: fields.branch,
    description: fields.description,
    expected_catchers: fields.expectedCatchers,
    base_url: fields.baseUrl,
  };
}

export function initialValueOfMutant(mutant: Mutant | undefined): JsonObject | undefined {
  if (mutant === undefined) {
    return undefined;
  }
  return {
    name: mutant.name,
    branch: mutant.branch,
    description: mutant.description,
    expected_catchers: [...mutant.expected_catchers],
    ...(mutant.base_url === null ? {} : { base_url: mutant.base_url }),
  };
}

export function hasDeployedMutant(mutants: readonly Mutant[]): boolean {
  return mutants.some((mutant) => mutant.status === "deployed");
}

export function hasMeasuredMutant(mutants: readonly Mutant[]): boolean {
  return mutants.some((mutant) => mutant.last_outcome !== null);
}
