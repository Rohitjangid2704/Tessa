import { RunContext, registerRunScript } from "../server/run-simulator";
import type { RunScript, RunScriptFactory, ScriptAction, ScriptContext } from "../simulation/script";
import { stableId } from "../stage2/ids";
import { planAttempt, previewOf, SIM_TURNS, type SimOutcomeMode } from "../stage7/sim-plan";
import { simulatorsOf } from "../stage7/sim-store";
import { mockState } from "../state";
import type { SimCheckedPayload, SimTurnPayload } from "@/lib/api/types";

const RUNNING_AT_MS = 300;
const FIRST_ATTEMPT_AT_MS = 600;
const CHECK_MS = 1000;
const ATTEMPT_GAP_MS = 400;
const FINISH_GAP_MS = 500;
const PERSONA_TURN_COST_USD = 0.012;
const CHECK_COST_USD = 0.02;
const OUTCOME_MODES: readonly SimOutcomeMode[] = ["mixed", "pass", "fail"];

export interface SimulationRequest {
  personaId: string;
  goalId: string;
  role: string;
  attempts: number;
  outcome?: SimOutcomeMode;
}

export function simulationParams(request: SimulationRequest): Record<string, unknown> {
  return {
    persona_id: request.personaId,
    goal_id: request.goalId,
    role: request.role,
    k: request.attempts,
    ...(request.outcome === undefined ? {} : { sim_outcome: request.outcome }),
  };
}

function readRequest(params: Record<string, unknown>): SimulationRequest | null {
  const { persona_id: personaId, goal_id: goalId, role, k, sim_outcome: outcome } = params;
  if (
    typeof personaId !== "string" ||
    typeof goalId !== "string" ||
    typeof role !== "string" ||
    typeof k !== "number"
  ) {
    return null;
  }
  const mode = OUTCOME_MODES.find((candidate) => candidate === outcome);
  return { personaId, goalId, role, attempts: k, ...(mode === undefined ? {} : { outcome: mode }) };
}

function emitSim(
  context: ScriptContext,
  type: "sim.turn" | "sim.checked",
  payload: SimTurnPayload | SimCheckedPayload,
): void {
  const timestamp = context instanceof RunContext ? context.timestamp() : undefined;
  context.state.appendRawEvent(context.record, type, payload, timestamp);
}

function failingScript(reason: string): RunScript {
  return {
    actions: [
      { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
      { atMs: RUNNING_AT_MS, label: "finish", run: (context) => context.finish("failed", reason) },
    ],
  };
}

export const simulateRunFactory: RunScriptFactory = ({ run, params }): RunScript => {
  const request = readRequest(params);
  const simulators = simulatorsOf(mockState);
  const persona = request === null ? undefined : simulators.personas.find(request.personaId);
  const goal = request === null ? undefined : simulators.goals.find(request.goalId);
  if (request === null || persona === undefined || goal === undefined) {
    return failingScript("The persona or the goal of this simulation no longer exists");
  }
  const mode = request.outcome ?? simulators.settings.outcome;
  const { turnMs } = simulators.settings;
  const attemptSpanMs = SIM_TURNS * turnMs + CHECK_MS + ATTEMPT_GAP_MS;
  const actions: ScriptAction[] = [
    { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
    {
      atMs: RUNNING_AT_MS,
      label: "running",
      checkpoint: "running",
      run: (context) => {
        context.setStatus("running");
        context.bumpCounters({ scenarios_total: request.attempts });
        context.tickProgress();
      },
    },
  ];
  for (let attempt = 0; attempt < request.attempts; attempt += 1) {
    const plan = planAttempt(persona, goal, attempt, mode);
    const sessionId = stableId("sim_session", run.id, attempt);
    const startMs = FIRST_ATTEMPT_AT_MS + attempt * attemptSpanMs;
    for (const turn of plan.transcript) {
      actions.push({
        atMs: startMs + turn.turn * turnMs,
        label: `attempt ${attempt + 1} turn ${turn.turn}`,
        run: (context) => {
          emitSim(context, "sim.turn", {
            sim_session_id: sessionId,
            turn: turn.turn,
            speaker: turn.speaker,
            text_preview: previewOf(turn.text),
          });
          if (turn.speaker === "persona") {
            context.addSpend(PERSONA_TURN_COST_USD);
          }
        },
      });
    }
    actions.push({
      atMs: startMs + SIM_TURNS * turnMs + CHECK_MS,
      label: `attempt ${attempt + 1} checked`,
      run: (context) => {
        simulators.addSession({
          id: sessionId,
          run_id: run.id,
          persona_id: persona.id,
          goal_id: goal.id,
          attempt,
          transcript: plan.transcript,
          checks: plan.checks,
          verdict: plan.verdict,
        });
        emitSim(context, "sim.checked", {
          sim_session_id: sessionId,
          checks: plan.checks,
          verdict: plan.verdict,
        });
        context.addSpend(CHECK_COST_USD);
        context.bumpCounters({ scenarios_done: 1, [plan.verdict.status]: 1 });
        context.tickProgress();
      },
    });
  }
  const finishAtMs =
    FIRST_ATTEMPT_AT_MS + request.attempts * attemptSpanMs - ATTEMPT_GAP_MS + FINISH_GAP_MS;
  actions.push({
    atMs: finishAtMs,
    label: "finish",
    checkpoint: "finishing",
    run: (context) => {
      context.flushProgress();
      context.finish("completed");
    },
  });
  return { actions };
};

registerRunScript("simulate", simulateRunFactory);
