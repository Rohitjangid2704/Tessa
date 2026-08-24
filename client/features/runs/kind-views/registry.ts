import type { ComponentType } from "react";
import type { RunKind } from "@/lib/api/types";
import { CalibrationView } from "./calibration-view";
import { ContractView } from "./contract-view";
import { DefaultView } from "./default-view";
import { ExploreView } from "./explore-view";
import { GenerateView } from "./generate-view";
import { ImportView } from "./import-view";
import { MutationView } from "./mutation-view";
import { RedteamView } from "./redteam-view";
import { ReplayView } from "./replay-view";
import { SeedView } from "./seed-view";
import { SimulateView } from "./simulate-view";
import { SuiteView } from "./suite-view";

export type RunKindViewProps = { runId: string };

export type RunKindView = ComponentType<RunKindViewProps>;

export const RUN_KIND_VIEWS: Readonly<Partial<Record<RunKind, RunKindView>>> = {
  suite: SuiteView,
  seed: SeedView,
  generate: GenerateView,
  explore: ExploreView,
  simulate: SimulateView,
  redteam: RedteamView,
  replay: ReplayView,
  mutation: MutationView,
  contract: ContractView,
  import: ImportView,
  calibration: CalibrationView,
};

export const FALLBACK_RUN_KIND_VIEW: RunKindView = DefaultView;

export function hasRunKindView(kind: RunKind): boolean {
  return RUN_KIND_VIEWS[kind] !== undefined;
}
