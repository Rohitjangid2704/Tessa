import { registerRunScript } from "../server/run-simulator";
import type { RunScript, RunScriptFactory, ScriptAction, ScriptContext } from "../simulation/script";
import { plusSeconds } from "../stage2/scenario-factory";
import { resolveBundle } from "../stage2/plan-service";
import { emitRaw, stampOf } from "../stage7/raw-events";
import { readReplayParams } from "../stage7/replay-service";
import { buildReplayScenario, registerReplayScenario } from "../stage7/replay-scenarios";
import { replayStore, type ReplayEntry } from "../stage7/replay-store";
import type { ReplayProgressPayload } from "@/lib/api/types";

const PLANNING_AT_MS = 300;
const RUNNING_AT_MS = 800;
const FIRST_BATCH_AT_MS = 1100;
const BATCH_GAP_MS = 650;
const FINISH_GAP_MS = 500;
const BATCH_COUNT = 8;

function progressOf(entry: ReplayEntry): ReplayProgressPayload {
  return {
    replay_id: entry.replayId,
    records_total: entry.records.length,
    cases_created: entry.records.filter((record) => record.status === "created").length,
    cases_rejected: entry.records.filter((record) => record.status === "rejected").length,
  };
}

function createScenario(context: ScriptContext, entry: ReplayEntry, index: number): void {
  const outcome = entry.outcomes[index];
  const scenarioId = outcome?.scenario_id ?? null;
  if (outcome === undefined || scenarioId === null) {
    return;
  }
  const target = context.state.stageOne.findTarget(entry.targetId);
  if (target === undefined) {
    return;
  }
  const bundle = resolveBundle(context.state.stageOne, target, context.run.bundle_id);
  registerReplayScenario(
    context.state,
    buildReplayScenario({
      scenarioId,
      targetId: entry.targetId,
      bundleId: bundle.bundle.id,
      bundleVersion: bundle.bundle.version,
      replayId: entry.replayId,
      excerpt: outcome.excerpt,
      status: entry.scenarioStatuses.get(scenarioId) ?? "in_review",
      createdAt: plusSeconds(stampOf(context), index),
    }),
  );
}

function applyBatch(context: ScriptContext, entry: ReplayEntry, from: number, to: number): void {
  let created = 0;
  let rejected = 0;
  for (let index = from; index < to; index += 1) {
    const outcome = entry.outcomes[index];
    if (outcome === undefined) {
      continue;
    }
    entry.records[index] = { ...outcome };
    if (outcome.status === "created") {
      createScenario(context, entry, index);
      created += 1;
    } else {
      rejected += 1;
    }
  }
  context.bumpCounters({ scenarios_done: created + rejected, pass: created, skipped: rejected });
  emitRaw(context, "replay.progress", progressOf(entry));
  context.tickProgress();
}

export const replayRunFactory: RunScriptFactory = ({ params }): RunScript => {
  const { replay_id: replayId } = readReplayParams(params);
  const entry = replayStore.find(replayId);
  const actions: ScriptAction[] = [
    { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
    { atMs: PLANNING_AT_MS, label: "planning", run: (context) => context.setStatus("planning") },
    {
      atMs: RUNNING_AT_MS,
      label: "running",
      checkpoint: "running",
      run: (context) => {
        context.setStatus("running");
        context.bumpCounters({ scenarios_total: entry?.records.length ?? 0 });
        if (entry !== undefined) {
          emitRaw(context, "replay.progress", progressOf(entry));
        }
        context.tickProgress();
      },
    },
  ];
  const total = entry?.records.length ?? 0;
  const size = Math.max(1, Math.ceil(total / BATCH_COUNT));
  let at = FIRST_BATCH_AT_MS;
  for (let from = 0; from < total; from += size) {
    const to = Math.min(total, from + size);
    if (entry !== undefined) {
      actions.push({
        atMs: at,
        label: `records ${from + 1} to ${to}`,
        checkpoint: from === 0 ? "first_scenario_finished" : undefined,
        run: (context) => applyBatch(context, entry, from, to),
      });
    }
    at += BATCH_GAP_MS;
  }
  actions.push({
    atMs: at + FINISH_GAP_MS / 2,
    label: "finishing",
    checkpoint: "finishing",
    run: () => undefined,
  });
  actions.push({
    atMs: at + FINISH_GAP_MS,
    label: "finish",
    run: (context) => {
      context.flushProgress();
      context.finish("completed");
    },
  });
  return { actions };
};

registerRunScript("replay", replayRunFactory);
