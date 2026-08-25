import { registerRunScript } from "../server/run-simulator";
import type { RunScript, RunScriptFactory, ScriptContext } from "../simulation/script";
import { FIT_FAILURE_REASON, proposalOf } from "../stage10/calibration-fit-data";
import { calibrationFits } from "../stage10/calibration-fit-store";

const RUNNING_AT_MS = 300;
const FIRST_STAGE_AT_MS = 1200;
const STAGE_GAP_MS = 1200;
const STAGE_COUNT = 3;
const STAGE_COST_USD = 0.05;
const FINISHING_GAP_MS = 500;
const FINISH_GAP_MS = 400;

function adoptThresholds(context: ScriptContext, runId: string): void {
  const stored = calibrationFits.find(runId);
  const proposal = stored === undefined ? null : proposalOf(stored.behaviour);
  if (proposal === null || proposal.kappa_after <= proposal.kappa_before) {
    return;
  }
  context.state.stageFour.settings.apply([
    { path: ["thresholds", "probe_confidence"], value: proposal.probe_confidence },
    { path: ["thresholds", "judge_escalate_below"], value: proposal.judge_escalate_below },
  ]);
}

function settleFit(context: ScriptContext, runId: string): void {
  const behaviour = calibrationFits.find(runId)?.behaviour ?? "adopted";
  context.flushProgress();
  if (behaviour === "failed") {
    context.finish("failed", FIT_FAILURE_REASON);
    return;
  }
  adoptThresholds(context, runId);
  context.finish("completed");
}

const calibrationFactory: RunScriptFactory = (input) => {
  const runId = input.run.id;
  const lastStageAt = FIRST_STAGE_AT_MS + (STAGE_COUNT - 1) * STAGE_GAP_MS;
  const finishingAt = lastStageAt + FINISHING_GAP_MS;
  const script: RunScript = {
    actions: [
      { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
      {
        atMs: RUNNING_AT_MS,
        label: "status running",
        checkpoint: "running",
        run: (context) => context.setStatus("running"),
      },
      ...Array.from({ length: STAGE_COUNT }, (_, index) => ({
        atMs: FIRST_STAGE_AT_MS + index * STAGE_GAP_MS,
        label: `fit stage ${index + 1}`,
        run: (context: ScriptContext) => {
          context.addSpend(STAGE_COST_USD);
          context.tickProgress();
        },
      })),
      { atMs: finishingAt, label: "finishing", checkpoint: "finishing", run: () => undefined },
      {
        atMs: finishingAt + FINISH_GAP_MS,
        label: "finish calibration fit",
        run: (context) => settleFit(context, runId),
      },
    ],
  };
  return script;
};

registerRunScript("calibration", calibrationFactory);
