import { stableInt } from "../stage2/ids";
import type { AdapterKind, Budget, RunStatus } from "@/lib/api/types";
import type { ScenarioDraft } from "./drafts";
import type { RunContext } from "./run-context";
import type { PhaseScript, RunScript, ScriptAction, ScriptContext } from "./script";

export const PLANNING_AT_MS = 300;
export const QUEUED_AT_MS = 900;
export const RUNNING_AT_MS = 1100;
export const FIRST_START_MS = 1300;
export const PROGRESS_INTERVAL_MS = 2000;
export const BUDGET_EXHAUSTED_FRACTION = 0.55;
export const BUDGET_OVERSHOOT = 1.02;
export const SCRIPTED_CANCEL_DRAIN_MS = 1200;

const SKIP_DURATION_MS = 150;
const ATTEMPT_GAP_MS = 200;
const SLOT_GAP_MS = 100;
const SESSION_OPEN_DELAY_MS = 250;
const STEP_GAP_BY_ADAPTER: Readonly<Record<AdapterKind, number>> = {
  http: 350,
  sse: 650,
  browser: 1100,
  websocket: 700,
  graphql: 400,
  webhook: 800,
  cli: 600,
};
const FINISH_DELAY_MS = 150;
const USD_DECIMALS = 1_000_000;

export interface ScriptedEnding {
  kind: "failed" | "canceled";
  atFraction: number;
  reason?: string;
}

export interface SuiteScriptInput {
  drafts: readonly ScenarioDraft[];
  concurrency: number;
  budget: Budget;
  budgetExhausted: boolean;
  stepCostUsd: number;
  seedKey: string;
  seeding: PhaseScript | null;
  ending?: ScriptedEnding;
}

interface StepSlot {
  atMs: number;
  step: { cost_usd: number };
}

function asRunContext(context: ScriptContext): RunContext {
  return context as RunContext;
}

function earliestSlot(slots: readonly number[]): number {
  let best = 0;
  slots.forEach((value, index) => {
    if ((slots[best] ?? Number.POSITIVE_INFINITY) > value) {
      best = index;
    }
  });
  return best;
}

export function sortActions(actions: readonly ScriptAction[]): ScriptAction[] {
  return actions
    .map((action, order) => ({ action, order }))
    .sort((left, right) => left.action.atMs - right.action.atMs || left.order - right.order)
    .map((entry) => entry.action);
}

function checkpointAction(atMs: number, checkpoint: string): ScriptAction {
  return { atMs, label: checkpoint, checkpoint, run: () => undefined };
}

export function buildSuiteScript(input: SuiteScriptInput): RunScript {
  const actions: ScriptAction[] = [];
  const stepSlots: StepSlot[] = [];
  const push = (action: ScriptAction) => actions.push(action);
  const seedingShift = input.seeding === null ? 0 : input.seeding.durationMs;
  const executionStart = FIRST_START_MS + seedingShift;

  push(checkpointAction(0, "created"));
  push({
    atMs: PLANNING_AT_MS,
    label: "status planning",
    run: (context) => context.setStatus("planning"),
  });
  push(checkpointAction(PLANNING_AT_MS, "planning"));
  push({
    atMs: QUEUED_AT_MS,
    label: "create run scenarios",
    run: (context) => asRunContext(context).createRunScenarios(input.drafts),
  });

  if (input.seeding !== null) {
    const seeding = input.seeding;
    push({
      atMs: QUEUED_AT_MS + 50,
      label: "status seeding",
      run: (context) => context.setStatus("seeding"),
    });
    push(checkpointAction(QUEUED_AT_MS + 50, "seeding"));
    for (const action of seeding.actions) {
      push({ ...action, atMs: QUEUED_AT_MS + 100 + action.atMs });
    }
    if (seeding.failure !== undefined) {
      const { reason } = seeding.failure;
      push({
        atMs: QUEUED_AT_MS + 100 + seeding.durationMs,
        label: "seeding failed",
        run: (context) => {
          asRunContext(context).abort("seed_mismatch");
          context.flushProgress();
          context.finish("failed", reason);
        },
      });
      return { actions: sortActions(actions) };
    }
  }

  push({
    atMs: RUNNING_AT_MS + seedingShift,
    label: "status running",
    run: (context) => context.setStatus("running"),
  });
  push(checkpointAction(RUNNING_AT_MS + seedingShift, "running"));

  const slots = Array.from({ length: input.concurrency }, () => executionStart);
  let firstStepSeen = false;
  let firstScenarioFinishedSeen = false;
  let lastAtMs = executionStart;

  for (const draft of input.drafts) {
    const slot = earliestSlot(slots);
    let cursor = slots[slot] ?? executionStart;
    if (draft.skip !== null) {
      const { skip } = draft;
      push({
        atMs: cursor,
        label: `skip ${draft.title}`,
        run: (context) => asRunContext(context).skipScenario(draft, skip),
      });
      cursor += SKIP_DURATION_MS;
      slots[slot] = cursor + SLOT_GAP_MS;
      lastAtMs = Math.max(lastAtMs, cursor);
      continue;
    }
    draft.attempts.forEach((attempt, attemptIndex) => {
      push({
        atMs: cursor,
        label: `start ${draft.title} #${attemptIndex}`,
        run: (context) => asRunContext(context).startAttempt(draft, attemptIndex),
      });
      let stepAt = cursor + (attempt.browser ? SESSION_OPEN_DELAY_MS : 100);
      if (attempt.browser) {
        push({
          atMs: stepAt,
          label: `open session ${draft.title} #${attemptIndex}`,
          run: (context) => asRunContext(context).openSession(draft, attemptIndex),
        });
      }
      attempt.steps.forEach((content, index) => {
        stepAt +=
          STEP_GAP_BY_ADAPTER[content.adapter] +
          stableInt(0, 250, input.seedKey, draft.scenario.id, attemptIndex, index);
        stepSlots.push({ atMs: stepAt, step: content });
        push({
          atMs: stepAt,
          label: `step ${draft.title} #${attemptIndex}.${index}`,
          run: (context) => {
            asRunContext(context).recordStep(draft, attemptIndex, index, content);
          },
        });
        if (!firstStepSeen) {
          firstStepSeen = true;
          push(checkpointAction(stepAt, "first_step"));
        }
      });
      stepAt += FINISH_DELAY_MS;
      if (attempt.browser) {
        push({
          atMs: stepAt,
          label: `close session ${draft.title} #${attemptIndex}`,
          run: (context) => asRunContext(context).closeSession(draft, attemptIndex),
        });
      }
      push({
        atMs: stepAt,
        label: `verdict ${draft.title} #${attemptIndex}`,
        run: (context) => {
          asRunContext(context).finishAttempt(draft, attemptIndex, attempt);
        },
      });
      cursor = stepAt + ATTEMPT_GAP_MS;
    });
    const finishAt = cursor - ATTEMPT_GAP_MS;
    push({
      atMs: finishAt,
      label: `finish ${draft.title}`,
      run: (context) => asRunContext(context).finishScenario(draft),
    });
    if (!firstScenarioFinishedSeen) {
      firstScenarioFinishedSeen = true;
      push(checkpointAction(finishAt, "first_scenario_finished"));
    }
    slots[slot] = finishAt + SLOT_GAP_MS;
    lastAtMs = Math.max(lastAtMs, finishAt);
  }

  const cutoffAt = (fraction: number): number =>
    Math.round(executionStart + (lastAtMs - executionStart) * fraction);
  let endAt = lastAtMs;
  let finalStatus: RunStatus = "completed";
  let kept = actions;
  let finalReason: string | null = null;

  if (input.budgetExhausted && stepSlots.length > 1) {
    const cutoff = cutoffAt(BUDGET_EXHAUSTED_FRACTION);
    const before = stepSlots.filter((slot) => slot.atMs <= cutoff);
    const perStep =
      Math.round(
        ((input.budget.max_usd * BUDGET_OVERSHOOT) / Math.max(1, before.length)) * USD_DECIMALS,
      ) / USD_DECIMALS;
    for (const slot of before) {
      slot.step.cost_usd = perStep;
    }
    kept = actions.filter((action) => action.atMs <= cutoff);
    kept.push({
      atMs: cutoff,
      label: "budget exhausted",
      run: (context) => {
        const { budget } = context.run;
        context.flushProgress();
        context.emit("budget.exhausted", {
          dimension: "usd",
          limit: budget.max_usd,
          actual: budget.spent_usd,
        });
        asRunContext(context).abort("budget_exceeded");
      },
    });
    endAt = cutoff;
    finalStatus = "budget_exceeded";
  } else if (input.ending !== undefined && stepSlots.length > 1) {
    const { ending } = input;
    const cutoff = cutoffAt(ending.atFraction);
    kept = actions.filter((action) => action.atMs <= cutoff);
    if (ending.kind === "canceled") {
      kept.push({
        atMs: cutoff,
        label: "cancel requested",
        run: (context) => context.setStatus("canceling"),
      });
      kept.push({
        atMs: cutoff + SCRIPTED_CANCEL_DRAIN_MS,
        label: "cancel drained",
        run: (context) => asRunContext(context).abort("canceled"),
      });
      endAt = cutoff + SCRIPTED_CANCEL_DRAIN_MS;
      finalStatus = "canceled";
    } else {
      kept.push({
        atMs: cutoff,
        label: "run failed",
        run: (context) => asRunContext(context).failInFlight(),
      });
      endAt = cutoff;
      finalStatus = "failed";
      finalReason = ending.reason ?? "The workflow failed";
    }
  } else if (input.stepCostUsd > 0) {
    for (const slot of stepSlots) {
      slot.step.cost_usd = input.stepCostUsd;
    }
  }

  for (let tick = PROGRESS_INTERVAL_MS; tick < endAt; tick += PROGRESS_INTERVAL_MS) {
    if (tick > RUNNING_AT_MS + seedingShift) {
      kept.push({ atMs: tick, label: "progress tick", run: (context) => context.tickProgress() });
    }
  }
  kept.push(checkpointAction(endAt + 50, "finishing"));
  kept.push({
    atMs: endAt + 100,
    label: "finish run",
    run: (context) => {
      context.flushProgress();
      context.finish(finalStatus, finalReason);
    },
  });
  return { actions: sortActions(kept) };
}
