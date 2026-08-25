import type { SeedPhase, SeedPhaseStatus } from "@/lib/api/types";
import type { PhaseScript, RunScript, ScriptAction, ScriptContext } from "../../simulation/script";
import { applySeedRun } from "./outcome";
import type { SeedRecord, SeedRunPlan } from "./types";

const RUNNING_AT_MS = 300;
const PHASE_GAP_MS = 100;
const RESET_MS = 1300;
const HASH_MS = 700;
const ASSERT_MS = 300;
const FINISH_GAP_MS = 100;
const SEEDING_FOOTPRINT_MS = 2000;

interface PhaseWindow {
  phase: SeedPhase;
  startAtMs: number;
  endAtMs: number;
}

function emitProgress(
  context: ScriptContext,
  plan: SeedRunPlan,
  phase: SeedPhase,
  status: SeedPhaseStatus,
): void {
  const knowsHashes = phase !== "reset";
  const showsObserved = knowsHashes && (status !== "started" || phase === "assert");
  context.emit("seed.progress", {
    phase,
    status,
    observed_hash: showsObserved ? plan.observedHash : null,
    expected_hash: knowsHashes ? plan.expectedHash : null,
  });
}

function phaseWindows(plan: SeedRunPlan, firstAtMs: number): PhaseWindow[] {
  const windows: PhaseWindow[] = [];
  let cursor = firstAtMs;
  const add = (phase: SeedPhase, durationMs: number) => {
    windows.push({ phase, startAtMs: cursor, endAtMs: cursor + durationMs });
    cursor += durationMs + PHASE_GAP_MS;
  };
  if (plan.action === "reset") {
    add("reset", RESET_MS);
  }
  if (!plan.resetFailed) {
    add("hash", HASH_MS);
    add("assert", ASSERT_MS);
  }
  return windows;
}

function windowActions(plan: SeedRunPlan, windows: readonly PhaseWindow[]): ScriptAction[] {
  return windows.flatMap((window): ScriptAction[] => {
    const resetFailed = window.phase === "reset" && plan.resetFailed;
    const assertFailed = window.phase === "assert" && !plan.matched;
    const failed = resetFailed || assertFailed;
    return [
      {
        atMs: window.startAtMs,
        label: `${window.phase} started`,
        run: (context) => emitProgress(context, plan, window.phase, "started"),
      },
      {
        atMs: window.endAtMs,
        label: `${window.phase} ${failed ? "failed" : "ok"}`,
        run: (context) => emitProgress(context, plan, window.phase, failed ? "failed" : "ok"),
      },
    ];
  });
}

function endOf(windows: readonly PhaseWindow[]): number {
  return windows.at(-1)?.endAtMs ?? 0;
}

export function buildSeedRunScript(record: SeedRecord, plan: SeedRunPlan): RunScript {
  const firstAtMs = RUNNING_AT_MS + PHASE_GAP_MS;
  const windows = phaseWindows(plan, firstAtMs);
  const failed = plan.resetFailed || !plan.matched;
  return {
    actions: [
      { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
      {
        atMs: RUNNING_AT_MS,
        label: "status running",
        checkpoint: "running",
        run: (context) => context.setStatus("running"),
      },
      ...windowActions(plan, windows),
      {
        atMs: endOf(windows) + FINISH_GAP_MS / 2,
        label: "finishing",
        checkpoint: "finishing",
        run: () => undefined,
      },
      {
        atMs: endOf(windows) + FINISH_GAP_MS,
        label: "finish seed run",
        run: (context) => {
          applySeedRun(record, plan, context.run.id, new Date().toISOString());
          if (plan.observedHash !== null) {
            context.run.config_snapshot.seed_hash = plan.observedHash;
          }
          if (failed) {
            context.finish("failed", plan.failureReason);
            return;
          }
          context.finish("completed");
        },
      },
    ],
  };
}

export function buildSeedingPhase(record: SeedRecord, plan: SeedRunPlan): PhaseScript {
  const windows = phaseWindows(plan, 0);
  const failed = plan.resetFailed || !plan.matched;
  const settle: ScriptAction = {
    atMs: endOf(windows),
    label: "seed settled",
    run: (context) => {
      applySeedRun(record, plan, context.run.id, new Date().toISOString());
      if (plan.observedHash !== null) {
        context.run.config_snapshot.seed_hash = plan.observedHash;
      }
    },
  };
  return {
    durationMs: Math.max(SEEDING_FOOTPRINT_MS, endOf(windows) + FINISH_GAP_MS),
    actions: [...windowActions(plan, windows), settle],
    ...(failed
      ? {
          failure: {
            reason:
              plan.failureReason === null
                ? "The seed could not be asserted"
                : `Seed assertion failed: ${plan.failureReason}`,
          },
        }
      : {}),
  };
}
