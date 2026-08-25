import { mockState } from "../state";

export interface ExplorationRecord {
  runId: string;
  goalText: string;
  role: string;
}

export class ExploreStore {
  private readonly records = new Map<string, ExplorationRecord>();
  private resetHookRegistered = false;

  reset(): void {
    this.records.clear();
  }

  register(record: ExplorationRecord): void {
    this.ensureResetHook();
    this.records.set(record.runId, record);
  }

  find(runId: string): ExplorationRecord | undefined {
    return this.records.get(runId);
  }

  private ensureResetHook(): void {
    if (this.resetHookRegistered) {
      return;
    }
    this.resetHookRegistered = true;
    mockState.stageTwo.onReset(() => this.reset());
  }
}

export const exploreStore = new ExploreStore();
