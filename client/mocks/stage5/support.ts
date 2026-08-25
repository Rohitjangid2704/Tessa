import type { FindingClass, FindingStatus, Severity } from "@/lib/api/types";
import type { ApiContext } from "../handlers/api";
import type { StageFiveStore } from "./store";
import type { FindingsStore } from "./findings-store";

export const FINDING_STATUSES = [
  "new",
  "triaged",
  "in_fix",
  "verifying",
  "resolved",
  "known_gap",
  "dismissed",
] as const satisfies readonly FindingStatus[];

export const FINDING_CLASSES = [
  "wrong_result",
  "invariant_violation",
  "server_error",
  "security_boundary",
  "safety_claim",
  "performance",
  "accessibility",
  "flaky",
  "contract",
  "harness",
] as const satisfies readonly FindingClass[];

export const FINDING_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const satisfies readonly Severity[];

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export function stageFive(context: ApiContext): StageFiveStore {
  return context.state.stageFive;
}

export function findingsStore(context: ApiContext): FindingsStore {
  return context.state.stageFive.findings;
}
