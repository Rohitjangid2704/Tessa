import type { RunKind } from "@/lib/api/types";
import type {
  AttemptVerdictResolver,
  RunScriptFactory,
  SeedingPhaseBuilder,
  StepRecordedHook,
} from "./script";

export interface SimulatorExtensions {
  runScripts: Map<RunKind, RunScriptFactory>;
  stepRecordedHooks: Set<StepRecordedHook>;
  attemptVerdictResolvers: Set<AttemptVerdictResolver>;
  seedingPhase: SeedingPhaseBuilder | null;
}

export const extensions: SimulatorExtensions = {
  runScripts: new Map(),
  stepRecordedHooks: new Set(),
  attemptVerdictResolvers: new Set(),
  seedingPhase: null,
};

export function registerRunScript(kind: RunKind, factory: RunScriptFactory): () => void {
  extensions.runScripts.set(kind, factory);
  return () => {
    if (extensions.runScripts.get(kind) === factory) {
      extensions.runScripts.delete(kind);
    }
  };
}

export function registerStepRecordedHook(hook: StepRecordedHook): () => void {
  extensions.stepRecordedHooks.add(hook);
  return () => {
    extensions.stepRecordedHooks.delete(hook);
  };
}

export function registerAttemptVerdictResolver(resolver: AttemptVerdictResolver): () => void {
  extensions.attemptVerdictResolvers.add(resolver);
  return () => {
    extensions.attemptVerdictResolvers.delete(resolver);
  };
}

export function registerSeedingPhase(builder: SeedingPhaseBuilder): () => void {
  extensions.seedingPhase = builder;
  return () => {
    if (extensions.seedingPhase === builder) {
      extensions.seedingPhase = null;
    }
  };
}
