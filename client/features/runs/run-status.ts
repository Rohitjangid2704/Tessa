import { RUN_TERMINAL_STATUSES } from "@/lib/api/polling";
import type { RunStatus } from "@/lib/api/types";

const TERMINAL_STATUSES: readonly RunStatus[] = RUN_TERMINAL_STATUSES;

const CANCELABLE_STATUSES: readonly RunStatus[] = ["queued", "planning", "seeding", "running"];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isCancelableRunStatus(status: RunStatus): boolean {
  return CANCELABLE_STATUSES.includes(status);
}

export function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}
