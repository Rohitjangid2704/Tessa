import { mockState } from "../state";

const stopped = new Set<string>();

let registered = false;

function ensureResetHook(): void {
  if (registered) {
    return;
  }
  registered = true;
  mockState.stageTwo.onReset(() => stopped.clear());
}

export function isRunStopRequested(runId: string): boolean {
  return stopped.has(runId);
}

export function markRunStopRequested(runId: string): void {
  ensureResetHook();
  stopped.add(runId);
}
