import { registerRunScript } from "../server/run-simulator";
import { stableInt, stableUnit } from "../stage2/ids";
import { plusSeconds } from "../stage2/scenario-factory";
import type { RunScript, RunScriptFactory, ScriptAction, ScriptContext } from "../simulation/script";
import type { Depth, GenerationProgressPayload } from "@/lib/api/types";
import { buildCellScenario, registerScenario, variantFor } from "./cell-scenarios";
import { publishCoverageUpdated, publishScenarioChanged } from "./coverage-bus";
import { readGenerationParams, type GenerationParams } from "./coverage-service";
import type { CoverageCellState } from "./coverage-data";
import { coverageStore } from "./coverage-store";

const PLANNING_AT_MS = 250;
const RUNNING_AT_MS = 600;
const FIRST_CELL_AT_MS = 900;
const FINISH_GAP_MS = 300;
const INVALID_RATE = 0.15;
const COST_PER_CELL_USD = 0.08;

const CELL_MS: Record<Depth, number> = { smoke: 350, standard: 900, deep: 1500 };

interface Tally {
  cellsDone: number;
  scenariosCreated: number;
  scenariosInvalid: number;
}

function scenarioCountFor(depth: Depth, cell: CoverageCellState): number {
  if (depth === "smoke") {
    return 1;
  }
  const base = depth === "standard" ? 2 : 4;
  return base + stableInt(0, 1, "generation_count", cell.id);
}

function emitProgress(context: ScriptContext, total: number, tally: Tally): void {
  const payload: GenerationProgressPayload = {
    cells_total: total,
    cells_done: tally.cellsDone,
    scenarios_created: tally.scenariosCreated,
    scenarios_invalid: tally.scenariosInvalid,
  };
  context.state.appendRawEvent(context.record, "generation.progress", payload);
}

function generateCell(
  context: ScriptContext,
  params: GenerationParams,
  cellId: string,
  tally: Tally,
): void {
  const located = coverageStore.findCell(cellId);
  const { depth } = params;
  if (located !== undefined && params.mode === "generate") {
    const { dataset, cell } = located;
    const wanted = scenarioCountFor(depth, cell);
    const invalid =
      depth !== "smoke" && stableUnit("generation_invalid", cell.id, context.run.id) < INVALID_RATE
        ? 1
        : 0;
    const created = wanted - invalid;
    const smoke = depth === "smoke";
    const startedAt = new Date().toISOString();
    for (let ordinal = 0; ordinal < created; ordinal += 1) {
      const scenario = buildCellScenario({
        dataset,
        cell,
        ordinal: cell.scenarioCount + ordinal,
        origin: smoke ? "bundle_example" : "generated",
        status: smoke ? "accepted" : "in_review",
        variant: smoke ? null : variantFor(ordinal),
        createdAt: plusSeconds(startedAt, ordinal),
        runId: context.run.id,
        depth,
      });
      registerScenario(context.state, scenario);
      publishScenarioChanged({
        targetId: dataset.targetId,
        scenarioId: scenario.id,
        cellId: cell.id,
        status: scenario.status,
      });
    }
    cell.scenarioCount += created;
    if (cell.status === "empty") {
      cell.status = "generated";
    }
    tally.scenariosCreated += created;
    tally.scenariosInvalid += invalid;
    if (!smoke) {
      context.addSpend(COST_PER_CELL_USD);
    }
    publishCoverageUpdated({
      targetId: dataset.targetId,
      planId: params.plan_id,
      cellIds: [cell.id],
      reason: "generated",
    });
  }
  tally.cellsDone += 1;
  emitProgress(context, params.cell_ids.length, tally);
  context.tickProgress();
}

export const generateRunFactory: RunScriptFactory = ({ params }): RunScript => {
  const request = readGenerationParams(params);
  const total = request.cell_ids.length;
  const tally: Tally = { cellsDone: 0, scenariosCreated: 0, scenariosInvalid: 0 };
  const perCellMs = CELL_MS[request.depth];
  const cellActions = request.cell_ids.map(
    (cellId, index): ScriptAction => ({
      atMs: FIRST_CELL_AT_MS + index * perCellMs,
      label: `generate cell ${index + 1}`,
      run: (context) => generateCell(context, request, cellId, tally),
    }),
  );
  const finishAtMs = FIRST_CELL_AT_MS + total * perCellMs + FINISH_GAP_MS;
  return {
    actions: [
      { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
      { atMs: PLANNING_AT_MS, label: "planning", run: (context) => context.setStatus("planning") },
      {
        atMs: RUNNING_AT_MS,
        label: "running",
        checkpoint: "running",
        run: (context) => {
          context.setStatus("running");
          emitProgress(context, total, tally);
        },
      },
      ...cellActions,
      {
        atMs: finishAtMs,
        label: "finish",
        run: (context) => {
          context.flushProgress();
          context.finish("completed");
        },
      },
    ],
  };
};

registerRunScript("generate", generateRunFactory);
