import { registerRunScript } from "../server/run-simulator";
import type { RunScript, RunScriptFactory, RunScriptInput, ScriptContext } from "../simulation/script";
import { overallOutcomeOf } from "../stage8/mutation-plan";
import { mutationStore } from "../stage8/mutation-store";
import { emitRaw, stampOf } from "../stage7/raw-events";
import type { MutationOutcome, MutationOutcomeItem } from "@/lib/api/types";

const RUNNING_AT_MS = 300;
const FIRST_OUTCOME_AT_MS = 1400;
const OUTCOME_GAP_MS = 1500;
const FINISHING_GAP_MS = 600;
const FINISH_GAP_MS = 400;
const FAILURE_AT_MS = 1800;
const OUTCOME_COST_USD = 0.04;
const DEFAULT_FAILURE_REASON = "The mutant did not answer its health check";

const OUTCOMES: readonly MutationOutcome[] = ["killed", "survived", "errored", "skipped"];

export interface MutationRunParams {
  mutationRunId: string;
  planned: MutationOutcomeItem[];
  failReason: string | null;
}

function readPlanned(value: unknown): MutationOutcomeItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry: unknown): MutationOutcomeItem[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const { invariant_id: invariantId, outcome, caught_by: caughtBy } = entry as Record<
      string,
      unknown
    >;
    const known = OUTCOMES.find((candidate) => candidate === outcome);
    if (typeof invariantId !== "string" || known === undefined) {
      return [];
    }
    return [
      {
        invariant_id: invariantId,
        outcome: known,
        caught_by: Array.isArray(caughtBy)
          ? caughtBy.filter((id): id is string => typeof id === "string")
          : [],
      },
    ];
  });
}

export function readMutationParams(params: Record<string, unknown>): MutationRunParams {
  return {
    mutationRunId: typeof params.mutation_run_id === "string" ? params.mutation_run_id : "",
    planned: readPlanned(params.planned),
    failReason: typeof params.fail_reason === "string" ? params.fail_reason : null,
  };
}

function recordOutcome(
  context: ScriptContext,
  params: MutationRunParams,
  item: MutationOutcomeItem,
): void {
  const stored = mutationStore.findRun(params.mutationRunId);
  if (stored === undefined) {
    return;
  }
  stored.outcomes = [
    ...stored.outcomes.filter((existing) => existing.invariant_id !== item.invariant_id),
    { ...item, caught_by: [...item.caught_by] },
  ];
  emitRaw(context, "mutation.outcome", {
    mutation_run_id: stored.id,
    invariant_id: item.invariant_id,
    outcome: item.outcome,
    caught_by: [...item.caught_by],
  });
  context.addSpend(OUTCOME_COST_USD);
  context.tickProgress();
}

function settleRun(context: ScriptContext, params: MutationRunParams): void {
  const stored = mutationStore.findRun(params.mutationRunId);
  if (stored !== undefined) {
    const scored = stored.outcomes.filter(
      (item) => item.outcome === "killed" || item.outcome === "survived",
    );
    const killed = scored.filter((item) => item.outcome === "killed").length;
    stored.power = scored.length === 0 ? null : killed / scored.length;
    stored.finishedAt = stampOf(context);
    const mutant = mutationStore.findMutant(stored.mutantId);
    const overall = overallOutcomeOf(stored.outcomes);
    if (mutant !== undefined && overall !== null) {
      mutant.last_outcome = overall;
    }
  }
  context.flushProgress();
  context.finish("completed");
}

function failedScript(params: MutationRunParams): RunScript {
  return {
    actions: [
      { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
      {
        atMs: RUNNING_AT_MS,
        label: "status running",
        checkpoint: "running",
        run: (context) => context.setStatus("running"),
      },
      {
        atMs: FAILURE_AT_MS,
        label: "mutation run failed",
        run: (context) => {
          const stored = mutationStore.findRun(params.mutationRunId);
          if (stored !== undefined) {
            stored.finishedAt = stampOf(context);
          }
          context.flushProgress();
          context.finish("failed", params.failReason ?? DEFAULT_FAILURE_REASON);
        },
      },
    ],
  };
}

export function buildMutationScript(input: RunScriptInput): RunScript {
  const params = readMutationParams(input.params);
  if (params.failReason !== null) {
    return failedScript(params);
  }
  const lastOutcomeAt = FIRST_OUTCOME_AT_MS + Math.max(0, params.planned.length - 1) * OUTCOME_GAP_MS;
  const finishingAt = lastOutcomeAt + FINISHING_GAP_MS;
  return {
    actions: [
      { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
      {
        atMs: RUNNING_AT_MS,
        label: "status running",
        checkpoint: "running",
        run: (context) => context.setStatus("running"),
      },
      ...params.planned.map((item, index) => ({
        atMs: FIRST_OUTCOME_AT_MS + index * OUTCOME_GAP_MS,
        label: `outcome ${item.invariant_id}`,
        checkpoint: index === 0 ? "first_step" : undefined,
        run: (context: ScriptContext) => recordOutcome(context, params, item),
      })),
      { atMs: finishingAt, label: "finishing", checkpoint: "finishing", run: () => undefined },
      {
        atMs: finishingAt + FINISH_GAP_MS,
        label: "finish mutation run",
        run: (context) => settleRun(context, params),
      },
    ],
  };
}

export const mutationRunFactory: RunScriptFactory = (input) => buildMutationScript(input);

registerRunScript("mutation", mutationRunFactory);
