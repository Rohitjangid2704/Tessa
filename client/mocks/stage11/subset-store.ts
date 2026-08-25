export const SUBSET_VARIANTS = ["default", "not_runnable"] as const;

export type SubsetVariant = (typeof SUBSET_VARIANTS)[number];

export class SubsetStore {
  variant: SubsetVariant = "default";

  reset(): void {
    this.variant = "default";
  }
}

export const subsetStore = new SubsetStore();
