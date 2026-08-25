import { FindingsStore, type FindingsSeed } from "./findings-store";

export type StageFiveSeed = FindingsSeed;

export class StageFiveStore {
  readonly findings = new FindingsStore();

  reset(seed: StageFiveSeed = "default"): void {
    this.findings.reset(seed);
  }
}
