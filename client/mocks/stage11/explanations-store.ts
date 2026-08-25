import { mockState } from "../state";

export const EXPLANATIONS_VARIANTS = ["structured", "text"] as const;

export type ExplanationsVariant = (typeof EXPLANATIONS_VARIANTS)[number];

export const DEFAULT_EXPLANATIONS_VARIANT: ExplanationsVariant = "text";

export class ExplanationsStore {
  variant: ExplanationsVariant = DEFAULT_EXPLANATIONS_VARIANT;

  get structured(): boolean {
    return this.variant === "structured";
  }

  reset(): void {
    this.variant = DEFAULT_EXPLANATIONS_VARIANT;
  }
}

export const explanationsStore = new ExplanationsStore();

mockState.stageTwo.onReset(() => explanationsStore.reset());
