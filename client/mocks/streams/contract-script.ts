import { registerRunScript } from "../server/run-simulator";
import type {
  RunScript,
  RunScriptFactory,
  ScriptAction,
  ScriptContext,
} from "../simulation/script";
import { emitRaw } from "../stage7/raw-events";
import { countBreaking, DEFAULT_ITEM_GAP_MS } from "../stage9/contracts-data";
import {
  contractStore,
  readContractRunParams,
  type ContractEntry,
} from "../stage9/contracts-store";
import type { ContractProgressPayload, RunCounters } from "@/lib/api/types";

const PLANNING_AT_MS = 300;
const RUNNING_AT_MS = 800;
const FIRST_ITEM_AT_MS = 1100;
const FINISH_GAP_MS = 500;

function progressOf(entry: ContractEntry): ContractProgressPayload {
  return {
    contract_check_id: entry.id,
    items_total: entry.items.length,
    items_done: entry.revealed,
    breaking: countBreaking(entry.items.slice(0, entry.revealed)),
  };
}

function revealItem(context: ScriptContext, entry: ContractEntry, index: number): void {
  const item = entry.items[index];
  if (item === undefined) {
    return;
  }
  entry.revealed = index + 1;
  const change: Partial<RunCounters> = { scenarios_done: 1 };
  change[item.verdict] = 1;
  context.bumpCounters(change);
  emitRaw(context, "contract.progress", progressOf(entry));
  context.tickProgress();
  if (entry.failAfter !== null && entry.revealed >= entry.failAfter) {
    context.flushProgress();
    context.finish("failed", entry.failReason);
  }
}

export const contractRunFactory: RunScriptFactory = ({ params }): RunScript => {
  const entry = contractStore.find(readContractRunParams(params).contract_check_id);
  const total = entry?.items.length ?? 0;
  const gapMs = entry?.itemGapMs ?? DEFAULT_ITEM_GAP_MS;
  const actions: ScriptAction[] = [
    { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
    { atMs: PLANNING_AT_MS, label: "planning", run: (context) => context.setStatus("planning") },
    {
      atMs: RUNNING_AT_MS,
      label: "running",
      checkpoint: "running",
      run: (context) => {
        context.setStatus("running");
        context.bumpCounters({ scenarios_total: total });
        if (entry !== undefined) {
          emitRaw(context, "contract.progress", progressOf(entry));
        }
        context.tickProgress();
      },
    },
  ];
  let at = FIRST_ITEM_AT_MS;
  for (let index = 0; index < total; index += 1) {
    if (entry !== undefined) {
      actions.push({
        atMs: at,
        label: `item ${index + 1}`,
        checkpoint: index === 0 ? "first_scenario_finished" : undefined,
        run: (context) => revealItem(context, entry, index),
      });
    }
    at += gapMs;
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

registerRunScript("contract", contractRunFactory);
