import type { LabelsSeed } from "./label-seed";
import { LabelsStore } from "./labels-store";
import { ProbesStore } from "./probes-store";
import { SettingsStore } from "./settings-store";

export type StageFourSeed = LabelsSeed;

export class StageFourStore {
  readonly labels = new LabelsStore();
  readonly probes = new ProbesStore();
  readonly settings = new SettingsStore();

  reset(seed: StageFourSeed = "default"): void {
    this.labels.reset(seed);
    this.probes.reset();
    this.settings.reset();
  }
}
