import type { ArtifactKind, Scenario, Step } from "@/lib/api/types";

export type MediaFixture = "png" | "webm" | "zip";

export interface ArtifactDef {
  id: string;
  kind: ArtifactKind;
  mime: string;
  fixture: MediaFixture;
  stepId: string;
  runId: string;
}

export interface ArtifactSpec {
  kind: ArtifactKind;
  fixture: MediaFixture;
  key?: string;
}

export interface ScenarioRecord {
  scenario: Scenario;
  cellKey: string | null;
}

export interface StepRecord {
  step: Step;
  ok: boolean | null;
  defs: ArtifactDef[];
}
