import { driftedHash } from "./catalog";
import type { SeedAction, SeedRecord, SeedRunPlan } from "./types";

export const RESET_FAILURE_MESSAGE = "The reset script exited with code 1 after 1.3 s";

function mismatchReason(observed: string, expected: string): string {
  return `The observed hash ${observed} does not match the declared hash ${expected}`;
}

export function planSeedRun(
  record: SeedRecord,
  action: SeedAction,
  mismatchFault: boolean,
): SeedRunPlan {
  const expected = record.declaredHash;
  if (action === "reset" && record.resetFails) {
    return {
      action,
      seedId: record.id,
      resetFailed: true,
      observedHash: null,
      expectedHash: expected,
      matched: false,
      recordedHash: null,
      failureReason: RESET_FAILURE_MESSAGE,
    };
  }
  const tampered = mismatchFault && expected !== null;
  const observed = tampered
    ? driftedHash(expected)
    : action === "reset"
      ? (expected ?? record.resetHash)
      : record.currentHash;
  const matched = expected === null || observed === expected;
  return {
    action,
    seedId: record.id,
    resetFailed: false,
    observedHash: observed,
    expectedHash: expected,
    matched,
    recordedHash: action === "reset" && expected === null ? observed : null,
    failureReason: matched || expected === null ? null : mismatchReason(observed, expected),
  };
}

export function applySeedRun(
  record: SeedRecord,
  plan: SeedRunPlan,
  runId: string,
  finishedAt: string,
): void {
  record.lastResetAt = finishedAt;
  record.lastResetRunId = runId;
  if (plan.resetFailed) {
    record.lastResetStatus = "failed";
    return;
  }
  record.observedHash = plan.observedHash;
  record.lastResetStatus = plan.matched ? "ok" : "mismatch";
  if (plan.action === "reset" && plan.observedHash !== null) {
    record.currentHash = plan.observedHash;
  }
  if (plan.recordedHash !== null) {
    record.declaredHash = plan.recordedHash;
    record.hashSource = "first_reset";
  }
}
