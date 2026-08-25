import type { MockState, RunRecord } from "../state";
import type { StageTwoStore } from "../stage2/store";
import type {
  Budget,
  Run,
  RunCounters,
  RunEvent,
  RunKind,
  RunStatus,
  SkipReason,
  Step,
  StreamEvent,
  Verdict,
} from "@/lib/api/types";
import type { StepContent } from "./step-content";

export type ScriptEventType = Exclude<StreamEvent["type"], `stream.${string}`>;

export type ScriptEventPayload<Type extends ScriptEventType> = Extract<
  StreamEvent,
  { type: Type }
>["payload"];

export type RunEventEmitter = <Type extends ScriptEventType>(
  type: Type,
  payload: ScriptEventPayload<Type>,
) => RunEvent;

export interface StepRecordedContext {
  readonly run: Run;
  readonly runScenarioId: string;
  readonly attempt: number;
  readonly step: Step;
  readonly atMs: number;
  emit: RunEventEmitter;
  updateStep: (patch: Partial<Pick<Step, "verdict" | "cost_usd" | "evidence">>) => void;
}

export type StepRecordedHook = (context: StepRecordedContext) => void;

export interface AttemptVerdictContext {
  readonly run: Run;
  readonly runScenarioId: string;
  readonly scenarioId: string;
  readonly attempt: number;
  readonly steps: readonly Step[];
  readonly defaultVerdict: Verdict;
  emit: RunEventEmitter;
}

export type AttemptVerdictResolver = (context: AttemptVerdictContext) => Verdict | null;

export interface ScriptContext {
  readonly state: MockState;
  readonly store: StageTwoStore;
  readonly run: Run;
  readonly record: RunRecord;
  readonly atMs: number;
  emit: RunEventEmitter;
  setStatus: (status: RunStatus, reason?: string | null) => void;
  finish: (status: RunStatus, reason?: string | null) => void;
  abort: (reason: SkipReason) => void;
  bumpCounters: (change: Partial<RunCounters>) => void;
  addSpend: (usd: number) => void;
  tickProgress: () => void;
  flushProgress: () => void;
}

export interface ScriptAction {
  atMs: number;
  label: string;
  checkpoint?: string;
  run: (context: ScriptContext) => void;
}

export interface RunScript {
  actions: ScriptAction[];
}

export interface RunScriptInput {
  run: Run;
  kind: RunKind;
  budget: Budget;
  params: Record<string, unknown>;
}

export type RunScriptFactory = (input: RunScriptInput, store: StageTwoStore) => RunScript;

export interface PhaseScript {
  durationMs: number;
  actions: ScriptAction[];
  failure?: { reason: string };
}

export interface SeedingPhaseInput {
  run: Run;
  targetId: string | null;
  params: Record<string, unknown>;
}

export type SeedingPhaseBuilder = (
  input: SeedingPhaseInput,
  store: StageTwoStore,
) => PhaseScript | null;

export type { StepContent };
