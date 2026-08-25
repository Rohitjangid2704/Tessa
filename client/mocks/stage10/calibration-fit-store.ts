import { mockState } from "../state";

export const FIT_BEHAVIOURS = ["adopted", "proposal", "failed"] as const;

export type FitBehaviour = (typeof FIT_BEHAVIOURS)[number];

export interface StoredFit {
  runId: string;
  targetId: string | null;
  createdAt: string;
  behaviour: FitBehaviour;
  heldOutLabels: number;
}

export class CalibrationFitStore {
  private readonly stored = new Map<string, StoredFit>();
  nextBehaviour: FitBehaviour = "adopted";

  add(fit: StoredFit): void {
    this.stored.set(fit.runId, fit);
  }

  find(runId: string): StoredFit | undefined {
    return this.stored.get(runId);
  }

  all(): StoredFit[] {
    return [...this.stored.values()];
  }

  consumeBehaviour(): FitBehaviour {
    const behaviour = this.nextBehaviour;
    this.nextBehaviour = "adopted";
    return behaviour;
  }

  reset(): void {
    this.stored.clear();
    this.nextBehaviour = "adopted";
  }
}

export const calibrationFits = new CalibrationFitStore();

mockState.stageTwo.onReset(() => calibrationFits.reset());
