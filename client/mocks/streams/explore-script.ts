import { buildFinding } from "../factories/finding";
import { registerRunScript, RunContext } from "../server/run-simulator";
import type { ScenarioDraft } from "../simulation/drafts";
import type { RunScript, RunScriptFactory, RunScriptInput, ScriptContext } from "../simulation/script";
import { stableHex, stableId } from "../stage2/ids";
import { baseUrlResolver } from "../stage2/plan-service";
import { renderScenarioYaml } from "../stage2/scenario-factory";
import type { StageTwoStore } from "../stage2/store";
import { exploreStepContent, EXPLORE_STEP_COST_USD } from "../stage7/explore-steps";
import {
  narrativeFor,
  pickVariant,
  type CandidatePlan,
  type ExploreNarrative,
  type NarrativeVariant,
} from "../stage7/explore-narrative";
import { emitRaw } from "../stage7/raw-events";
import { isRunStopRequested, markRunStopRequested } from "../stage7/stop-requests";
import { mockState } from "../state";
import type { Finding, Scenario } from "@/lib/api/types";

export const EXPLORE_DEFAULT_MAX_STEPS = 40;

const PLANNING_AT_MS = 300;
const SESSION_AT_MS = 450;
const FIRST_MOVE_AT_MS = 900;
const MOVE_GAP_MS = 1100;
const END_GAP_MS = 400;
const VERIFY_GAP_MS = 1500;
const FINISH_GAP_MS = 1000;
const EXPLORER_INTERFACE_ID = "browser";
const EXPLORER_FAMILY = "exploration";

export interface ExploreRunParams {
  goalText: string;
  role: string;
  maxSteps: number;
  variant: NarrativeVariant;
  stopAfterAction: number | null;
  reuseFindings: boolean;
}

interface Progress {
  ended: boolean;
  found: CandidatePlan[];
}

function readText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

export function readExploreParams(params: Record<string, unknown>): ExploreRunParams {
  const goalText = readText(params.goal_text, "Explore the app and report anything that looks wrong");
  const maxSteps =
    typeof params.max_steps === "number" && Number.isInteger(params.max_steps) && params.max_steps > 0
      ? params.max_steps
      : EXPLORE_DEFAULT_MAX_STEPS;
  const goalKind = typeof params.goal_kind === "string" ? params.goal_kind : null;
  const variant =
    params.variant === "clean" || params.variant === "findings"
      ? params.variant
      : pickVariant(goalKind, goalText);
  return {
    goalText,
    role: readText(params.role, "member"),
    maxSteps,
    variant,
    stopAfterAction:
      typeof params.stop_after_action === "number" ? params.stop_after_action : null,
    reuseFindings: params.reuse_findings === true,
  };
}

export function ensureExplorationScenario(
  store: StageTwoStore,
  targetId: string,
  bundleId: string,
  createdAt: string,
): Scenario {
  const id = stableId("scenario_exploration", targetId);
  const existing = store.findScenario(id);
  if (existing !== undefined) {
    return existing.scenario;
  }
  const doc = {
    schema_version: 1,
    title: "Exploration: free browsing toward a goal",
    feature_id: null,
    family: EXPLORER_FAMILY,
    role: "member",
    interface_id: EXPLORER_INTERFACE_ID,
    timeout_seconds: 600,
    synthetic: true,
    steps: [],
  };
  const scenario: Scenario = {
    id,
    target_id: targetId,
    bundle_id: bundleId,
    feature_id: null,
    cell_id: null,
    title: doc.title,
    family: EXPLORER_FAMILY,
    origin: "explorer",
    status: "accepted",
    version: 1,
    yaml: renderScenarioYaml(doc),
    parsed: JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
    synthetic: true,
    validation: { valid: true, errors: [], warnings: [] },
    provenance: { source: "explorer" },
    created_at: createdAt,
    updated_at: createdAt,
  };
  store.addScenario({ scenario, cellKey: null });
  return scenario;
}

function asRunContext(context: ScriptContext): RunContext {
  if (!(context instanceof RunContext)) {
    throw new Error("The explorer script needs the run simulator context");
  }
  return context;
}

function draftOf(
  runScenarioId: string,
  scenario: Scenario,
  role: string,
  title: string,
): ScenarioDraft {
  return {
    runScenarioId,
    scenario,
    role,
    interfaceId: EXPLORER_INTERFACE_ID,
    family: EXPLORER_FAMILY,
    title,
    skip: null,
    attemptsTotal: 1,
    attempts: [],
  };
}

function findingEventPayload(finding: Finding) {
  return {
    finding_id: finding.id,
    title: finding.title,
    class: finding.class,
    severity: finding.severity,
    status: finding.status,
    fingerprint: finding.fingerprint,
    is_new: true,
    scenario_id: finding.scenario_id,
  };
}

function findingFor(
  rc: RunContext,
  candidate: CandidatePlan,
  scenario: Scenario,
  reuse: boolean,
): Finding | null {
  const plan = candidate.finding;
  if (plan === null) {
    return null;
  }
  const store = mockState.stageFive.findings;
  if (reuse) {
    const existing = store.all.find((finding) => finding.class === plan.class);
    if (existing !== undefined) {
      return existing;
    }
  }
  const id = stableId("finding_explore", rc.run.id, candidate.key);
  const known = store.find(id);
  if (known !== undefined) {
    return known;
  }
  const at = rc.timestamp();
  return store.add({
    runIds: [rc.run.id],
    finding: buildFinding({
      id,
      target_id: scenario.target_id,
      fingerprint: stableHex(16, "finding_fingerprint_explore", rc.run.id, candidate.key),
      title: plan.title,
      class: plan.class,
      severity: plan.severity,
      status: "new",
      scenario_id: scenario.id,
      first_seen_at: at,
      last_seen_at: at,
      first_seen_run_id: rc.run.id,
      last_seen_run_id: rc.run.id,
      occurrence_count: 1,
      expected: plan.expected,
      actual: plan.actual,
    }),
  });
}

export function buildExploreScript(input: RunScriptInput, store: StageTwoStore): RunScript {
  const params = readExploreParams(input.params);
  const { run } = input;
  const runId = run.id;
  const targetId = run.target_id ?? "";
  const webBase = baseUrlResolver(mockState.stageOne, targetId)(EXPLORER_INTERFACE_ID);
  const narrative: ExploreNarrative = narrativeFor({
    webBase,
    role: params.role,
    goalText: params.goalText,
    variant: params.variant,
  });
  const scenario = ensureExplorationScenario(
    store,
    targetId,
    run.bundle_id ?? "",
    run.created_at,
  );
  const primary = draftOf(
    stableId("run_scenario", runId, "explorer"),
    scenario,
    params.role,
    `Exploration: ${params.goalText}`,
  );
  const progress: Progress = { ended: false, found: [] };
  const lastMoveAt = FIRST_MOVE_AT_MS + (narrative.moves.length - 1) * MOVE_GAP_MS;
  const endAt = lastMoveAt + END_GAP_MS;

  function emitFinish(context: ScriptContext, index: number, rationale: string): void {
    emitRaw(context, "explore.action", {
      index,
      action: "finish",
      target: null,
      text: null,
      url: null,
      rationale,
    });
    progress.ended = true;
  }

  function stopInline(context: ScriptContext): void {
    const rc = asRunContext(context);
    markRunStopRequested(runId);
    rc.run.stop_requested_at = rc.timestamp();
    emitRaw(context, "run.stop_requested", { requested_by: rc.run.created_by });
  }

  function runMove(context: ScriptContext, index: number): void {
    if (progress.ended) {
      return;
    }
    if (params.stopAfterAction === index && !isRunStopRequested(runId)) {
      stopInline(context);
    }
    if (isRunStopRequested(runId)) {
      emitFinish(
        context,
        index,
        "Stop requested: finishing after the last step and verifying what was found.",
      );
      return;
    }
    if (index >= params.maxSteps) {
      emitFinish(context, index, `Reached the limit of ${params.maxSteps} steps; finishing.`);
      return;
    }
    const move = narrative.moves[index];
    if (move === undefined) {
      return;
    }
    if (move.action === "finish" || move.page === null) {
      emitFinish(context, index, move.rationale);
      return;
    }
    const rc = asRunContext(context);
    emitRaw(context, "explore.action", {
      index,
      action: move.action,
      target: move.target,
      text: move.text,
      url: move.url,
      rationale: move.rationale,
    });
    rc.recordStep(
      primary,
      0,
      index,
      exploreStepContent({
        move,
        page: move.page,
        webBase,
        seed: `${runId}:${index}`,
        costUsd: EXPLORE_STEP_COST_USD,
      }),
    );
    for (const candidate of narrative.candidates) {
      if (candidate.toIndex === index && !progress.found.includes(candidate)) {
        progress.found.push(candidate);
        emitRaw(context, "explore.candidate", {
          candidate_id: stableId("explore_candidate", runId, candidate.key),
          description: candidate.description,
          from_index: candidate.fromIndex,
          to_index: candidate.toIndex,
        });
      }
    }
    context.tickProgress();
  }

  function verify(context: ScriptContext, candidate: CandidatePlan): void {
    const rc = asRunContext(context);
    const replay = draftOf(
      stableId("run_scenario", runId, "replay", candidate.key),
      scenario,
      params.role,
      `Replay: ${candidate.description}`,
    );
    rc.createRunScenarios([replay]);
    rc.startAttempt(replay, 0);
    let stepIndex = 0;
    for (let index = candidate.fromIndex; index <= candidate.toIndex; index += 1) {
      const move = narrative.moves[index];
      const page = candidate.reproduces ? move?.page : (move?.replayPage ?? move?.page);
      if (move === undefined || page === null || page === undefined) {
        continue;
      }
      rc.recordStep(
        replay,
        0,
        stepIndex,
        exploreStepContent({
          move,
          page,
          webBase,
          seed: `${runId}:replay:${candidate.key}:${index}`,
          costUsd: 0,
        }),
      );
      stepIndex += 1;
    }
    rc.finishAttempt(replay, 0, {
      outcome: candidate.reproduces ? "fail" : "pass",
      steps: [],
      browser: false,
      lastUrl: null,
    });
    rc.finishScenario(replay);
    const finding = candidate.reproduces
      ? findingFor(rc, candidate, scenario, params.reuseFindings)
      : null;
    emitRaw(context, "explore.verified", {
      candidate_id: stableId("explore_candidate", runId, candidate.key),
      verified: candidate.reproduces,
      replay_run_scenario_id: replay.runScenarioId,
      finding_id: finding?.id ?? null,
    });
    if (finding !== null) {
      emitRaw(context, "finding.created", findingEventPayload(finding));
    }
    context.tickProgress();
  }

  const moveActions = narrative.moves.map((_, index) => ({
    atMs: FIRST_MOVE_AT_MS + index * MOVE_GAP_MS,
    label: `explore move ${index}`,
    checkpoint: index === 0 ? "first_step" : undefined,
    run: (context: ScriptContext) => runMove(context, index),
  }));

  const verifyStartAt = endAt + 600;
  const verifyActions = narrative.candidates.map((candidate, order) => ({
    atMs: verifyStartAt + order * VERIFY_GAP_MS,
    label: `verify ${candidate.key}`,
    run: (context: ScriptContext) => {
      if (progress.found.includes(candidate)) {
        verify(context, candidate);
      }
    },
  }));

  const finishAt = verifyStartAt + narrative.candidates.length * VERIFY_GAP_MS + FINISH_GAP_MS;

  return {
    actions: [
      { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
      {
        atMs: PLANNING_AT_MS,
        label: "status running",
        checkpoint: "running",
        run: (context) => context.setStatus("running"),
      },
      {
        atMs: SESSION_AT_MS,
        label: "open exploration session",
        run: (context) => {
          const rc = asRunContext(context);
          rc.createRunScenarios([primary]);
          rc.startAttempt(primary, 0);
          rc.openSession(primary, 0);
        },
      },
      ...moveActions,
      {
        atMs: endAt,
        label: "close exploration session",
        run: (context) => {
          if (!progress.ended) {
            emitFinish(context, narrative.moves.length, "Out of planned moves; finishing.");
          }
          asRunContext(context).closeSession(primary, 0);
        },
      },
      ...verifyActions,
      {
        atMs: finishAt - FINISH_GAP_MS / 2,
        label: "finishing",
        checkpoint: "finishing",
        run: () => undefined,
      },
      {
        atMs: finishAt,
        label: "finish exploration",
        run: (context) => {
          const rc = asRunContext(context);
          rc.finishAttempt(primary, 0, { outcome: "pass", steps: [], browser: true, lastUrl: null });
          rc.finishScenario(primary);
          context.flushProgress();
          context.finish("completed");
        },
      },
    ],
  };
}

export const exploreRunFactory: RunScriptFactory = (input, store) =>
  buildExploreScript(input, store);

registerRunScript("explore", exploreRunFactory);
