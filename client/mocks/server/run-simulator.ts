import {
  emptyCounters,
  RunContext,
  SIMULATION_FRAME_POOL,
  type ContextMode,
} from "../simulation/run-context";
import { extensions } from "../simulation/extensions";
import type { RunScript, RunScriptInput } from "../simulation/script";
import { stableId } from "../stage2/ids";
import type { RunEntry, StageTwoStore } from "../stage2/store";
import type { MockState, RunRecord } from "../state";
import type { Budget, Run, RunConfigSnapshot, RunKind, RunTrigger } from "@/lib/api/types";

export {
  registerAttemptVerdictResolver,
  registerRunScript,
  registerSeedingPhase,
  registerStepRecordedHook,
} from "../simulation/extensions";
export type {
  AttemptVerdictContext,
  AttemptVerdictResolver,
  PhaseScript,
  RunScript,
  RunScriptFactory,
  RunScriptInput,
  ScriptAction,
  ScriptContext,
  SeedingPhaseBuilder,
  SeedingPhaseInput,
  StepRecordedContext,
  StepRecordedHook,
} from "../simulation/script";
export { RunContext } from "../simulation/run-context";

export const CANCEL_DRAIN_MS = 1200;
const TEMPORAL_UI_ORIGIN = "http://localhost:8233";
const WORKFLOW_PREFIX: Partial<Record<RunKind, string>> = {
  suite: "execute-run",
  generate: "plan-coverage",
};

export interface LaunchOptions {
  kind: RunKind;
  createdBy: string;
  targetId: string | null;
  planId: string | null;
  bundleId: string | null;
  readOnly: boolean;
  budget: Budget;
  configSnapshot: RunConfigSnapshot;
  trigger?: RunTrigger;
  params?: Record<string, unknown>;
  script?: RunScript | ((run: Run) => RunScript);
  mode?: ContextMode;
  id?: string;
  createdAtMs?: number;
}

function workflowIdOf(kind: RunKind, id: string): string {
  return `${WORKFLOW_PREFIX[kind] ?? kind}-${id}`;
}

function buildRunRow(options: LaunchOptions, id: string, createdAt: string): Run {
  const workflowId = workflowIdOf(options.kind, id);
  return {
    id,
    kind: options.kind,
    target_id: options.targetId,
    plan_id: options.planId,
    run_group_id: null,
    status: "queued",
    counters: emptyCounters(),
    budget: {
      max_usd: options.budget.max_usd,
      spent_usd: 0,
      max_minutes: options.budget.max_minutes,
      elapsed_ms: 0,
    },
    read_only: options.readOnly,
    started_at: null,
    finished_at: null,
    created_at: createdAt,
    trigger: options.trigger ?? "manual",
    bundle_id: options.bundleId,
    config_snapshot: options.configSnapshot,
    event_head_seq: 0,
    workflow_id: workflowId,
    temporal_ui_url: `${TEMPORAL_UI_ORIGIN}/namespaces/default/workflows/${workflowId}`,
    stop_requested_at: null,
    created_by: options.createdBy,
  };
}

function resolveScript(
  store: StageTwoStore,
  options: LaunchOptions,
  run: Run,
  params: Record<string, unknown>,
): RunScript {
  if (typeof options.script === "function") {
    return options.script(run);
  }
  if (options.script !== undefined) {
    return options.script;
  }
  const factory = extensions.runScripts.get(options.kind);
  if (factory !== undefined) {
    const input: RunScriptInput = { run, kind: options.kind, budget: options.budget, params };
    return factory(input, store);
  }
  return {
    actions: [
      { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
      { atMs: 300, label: "status running", run: (context) => context.setStatus("running") },
      { atMs: 900, label: "finish run", run: (context) => context.finish("completed") },
    ],
  };
}

export class RunPlayer {
  private frozenMs = 0;
  private startedVirtualMs = 0;
  private cancelRequested = false;
  private resolveCancel: () => void = () => undefined;
  private readonly cancelSignal: Promise<void>;

  constructor(
    private readonly store: StageTwoStore,
    private readonly context: RunContext,
    private readonly script: RunScript,
  ) {
    this.cancelSignal = new Promise((resolve) => {
      this.resolveCancel = resolve;
    });
  }

  get canceled(): boolean {
    return this.cancelRequested;
  }

  requestCancel(): void {
    if (this.cancelRequested) {
      return;
    }
    this.cancelRequested = true;
    this.context.setStatus("canceling");
    this.resolveCancel();
  }

  async play(): Promise<void> {
    const { clock } = this.store;
    this.startedVirtualMs = clock.now();
    for (const action of this.script.actions) {
      if (this.cancelRequested) {
        break;
      }
      const due = this.startedVirtualMs + this.frozenMs + action.atMs;
      const reached = await Promise.race([
        clock.sleepUntil(due).then(() => true),
        this.cancelSignal.then(() => false),
      ]);
      if (!reached) {
        break;
      }
      this.context.moveTo(action.atMs);
      action.run(this.context);
      if (action.checkpoint !== undefined) {
        await this.checkpoint(action.checkpoint);
      }
      if (this.context.record.finished) {
        return;
      }
    }
    if (this.cancelRequested && !this.context.record.finished) {
      await this.finishCanceled();
    }
  }

  private activeMs(): number {
    return this.store.clock.now() - this.startedVirtualMs - this.frozenMs;
  }

  private async finishCanceled(): Promise<void> {
    await this.store.clock.sleep(CANCEL_DRAIN_MS);
    this.context.moveTo(this.activeMs());
    this.context.abort("canceled");
    this.context.flushProgress();
    this.context.finish("canceled");
  }

  private shouldHold(phase: string): boolean {
    const runId = this.context.run.id;
    return this.store.controls.holds.some(
      (hold) => hold.phase === phase && (hold.runId === null || hold.runId === runId),
    );
  }

  private async checkpoint(phase: string): Promise<void> {
    if (this.cancelRequested || !this.shouldHold(phase)) {
      return;
    }
    const { controls, clock } = this.store;
    const runId = this.context.run.id;
    const frozenFrom = clock.now();
    controls.held.set(runId, phase);
    await Promise.race([
      new Promise<void>((resolve) => {
        controls.releasers.set(runId, resolve);
      }),
      this.cancelSignal,
    ]);
    controls.held.delete(runId);
    controls.releasers.delete(runId);
    this.frozenMs += clock.now() - frozenFrom;
  }
}

const playersByStore = new WeakMap<StageTwoStore, Map<string, RunPlayer>>();

function playersOf(store: StageTwoStore): Map<string, RunPlayer> {
  const existing = playersByStore.get(store);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, RunPlayer>();
  playersByStore.set(store, created);
  store.onReset(() => created.clear());
  return created;
}

export function playInstant(context: RunContext, script: RunScript): void {
  for (const action of script.actions) {
    context.moveTo(action.atMs);
    action.run(context);
    if (context.record.finished) {
      return;
    }
  }
}

export function launchRun(
  state: MockState,
  store: StageTwoStore,
  options: LaunchOptions,
): RunEntry {
  const mode: ContextMode = options.mode ?? { kind: "live" };
  const id = options.id ?? stableId("run_live", store.nextOrdinal("run"));
  const createdAtMs = options.createdAtMs ?? Date.now();
  const run = buildRunRow(options, id, new Date(createdAtMs).toISOString());
  const record: RunRecord = {
    id,
    createdBy: options.createdBy,
    events: [],
    finished: false,
    timers: [],
  };
  if (mode.kind === "live") {
    record.frameSessions = [];
    record.framePoolSize = SIMULATION_FRAME_POOL;
  }
  const entry: RunEntry = { run, record };
  store.addRun(entry);
  const context = new RunContext(state, store, entry, mode);
  context.emit("run.created", {
    kind: options.kind,
    target_id: options.targetId,
    plan_id: options.planId,
    trigger: run.trigger,
    created_by: options.createdBy,
    status: "queued",
  });
  const script = resolveScript(store, options, run, options.params ?? {});
  if (mode.kind === "instant") {
    playInstant(context, script);
    return entry;
  }
  const player = new RunPlayer(store, context, script);
  playersOf(store).set(id, player);
  void player.play().catch((error: unknown) => {
    if (!record.finished) {
      context.finish("failed", error instanceof Error ? error.message : "The simulator failed");
    }
  });
  return entry;
}

export function requestRunCancel(store: StageTwoStore, runId: string): boolean {
  const player = playersOf(store).get(runId);
  if (player === undefined) {
    return false;
  }
  player.requestCancel();
  return true;
}

export function isCancelRequested(store: StageTwoStore, runId: string): boolean {
  return playersOf(store).get(runId)?.canceled ?? false;
}

export function registerHold(store: StageTwoStore, phase: string, runId: string | null): void {
  const { holds } = store.controls;
  if (!holds.some((hold) => hold.phase === phase && hold.runId === runId)) {
    holds.push({ phase, runId });
  }
}

export function releaseHolds(
  store: StageTwoStore,
  filter: { phase?: string; runId?: string } = {},
): number {
  const { controls } = store;
  controls.holds = controls.holds.filter(
    (hold) =>
      !(
        (filter.phase === undefined || hold.phase === filter.phase) &&
        (filter.runId === undefined || hold.runId === null || hold.runId === filter.runId)
      ),
  );
  let released = 0;
  for (const [runId, phase] of [...controls.held]) {
    if (
      (filter.phase === undefined || phase === filter.phase) &&
      (filter.runId === undefined || runId === filter.runId)
    ) {
      controls.releasers.get(runId)?.();
      released += 1;
    }
  }
  return released;
}
