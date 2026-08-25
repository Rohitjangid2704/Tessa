import { conflict, MockApiError, validationFailed } from "../factories/errors";
import type { ApiContext } from "../handlers/api";
import { launchRun } from "../server/run-simulator";
import { assertTeamBudget } from "../stage10/teams-guard";
import { BodyReader, type Source } from "../stage1/body";
import { requireActiveTarget } from "../stage1/support";
import { buildConfigSnapshot, parseBudget } from "../stage2/plan-service";
import { isTerminal, nowIso, stageTwo } from "../stage2/support";
import type { RunEntry } from "../stage2/store";
import type { MockUser } from "../types";
import type { Budget, GoalKind, RunHandle, RunKind } from "@/lib/api/types";
import "../streams/explore-script";
import { exploreStore } from "./explore-store";
import { simulatorsOf } from "./sim-store";
import { isRunStopRequested, markRunStopRequested } from "./stop-requests";

export const GOAL_KINDS = [
  "reach_state",
  "extract_fact",
  "attempt_forbidden",
  "complete_flow",
] as const satisfies readonly GoalKind[];

export const DEFAULT_GOAL_KIND: GoalKind = "attempt_forbidden";
export const GOAL_TEXT_MAX_LENGTH = 2000;
export const MAX_STEPS_LIMIT = 200;
export const STOPPABLE_KINDS: readonly RunKind[] = ["explore", "simulate", "redteam"];

export interface ParsedExploration {
  targetId: string;
  role: string;
  goalId: string | null;
  goalText: string | null;
  goalKind: GoalKind;
  maxSteps: number | null;
  budget: Budget;
}

function readMaxSteps(source: Source, reader: BodyReader): number | null {
  const raw = source.max_steps;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    reader.issue("max_steps", "int_type", "Input should be a valid integer");
    return null;
  }
  if (raw < 1) {
    reader.issue("max_steps", "greater_than_equal", "Input should be greater than or equal to 1");
    return null;
  }
  if (raw > MAX_STEPS_LIMIT) {
    reader.issue(
      "max_steps",
      "less_than_equal",
      `Input should be less than or equal to ${MAX_STEPS_LIMIT}`,
    );
    return null;
  }
  return raw;
}

export function parseExplorationCreate(body: Source): ParsedExploration {
  const reader = new BodyReader(body);
  const targetId = reader.uuid("target_id", { required: true });
  const role = reader.string("role", { required: true, min: 1, max: 120, strip: true });
  const goalId = reader.uuid("goal_id", { required: false, nullable: true });
  const goalText = reader.string("goal_text", {
    required: false,
    nullable: true,
    min: 1,
    max: GOAL_TEXT_MAX_LENGTH,
    strip: true,
  });
  const goalKind = reader.enum("goal_kind", GOAL_KINDS, { required: false, nullable: true });
  const maxSteps = readMaxSteps(body, reader);
  const details = [...reader.details];
  let budget: Budget | undefined;
  if (body.budget === undefined) {
    details.push({ loc: ["body", "budget"], code: "missing", message: "Field required" });
  } else {
    budget = parseBudget(body.budget, ["body", "budget"], details);
  }
  const hasId = goalId !== undefined && goalId !== null;
  const hasText = goalText !== undefined && goalText !== null;
  if (details.length === 0 && hasId === hasText) {
    details.push({
      loc: ["body"],
      code: "value_error",
      message: "Value error, send exactly one of goal_id and goal_text",
    });
  }
  if (details.length === 0 && hasId && goalKind !== undefined && goalKind !== null) {
    details.push({
      loc: ["body", "goal_kind"],
      code: "value_error",
      message: "Value error, goal_kind applies only to goal_text",
    });
  }
  if (details.length > 0 || targetId == null || role == null || budget === undefined) {
    throw validationFailed(details);
  }
  return {
    targetId,
    role,
    goalId: goalId ?? null,
    goalText: goalText ?? null,
    goalKind: goalKind ?? DEFAULT_GOAL_KIND,
    maxSteps,
    budget,
  };
}

export function productionBlockedError(targetName: string): MockApiError {
  return new MockApiError(
    409,
    "production_blocked",
    `${targetName} is a production target and does not allow this session`,
    [
      {
        loc: ["target", "allow_production"],
        code: "production_blocked",
        message: "An admin must enable allow_production for this target",
      },
    ],
  );
}

export function startExploration(
  context: ApiContext,
  user: MockUser,
  parsed: ParsedExploration,
): RunHandle {
  const { state } = context;
  const target = requireActiveTarget(context, parsed.targetId);
  if (state.faults.productionBlocked || (target.tier === "production" && !target.allowProduction)) {
    throw productionBlockedError(target.name);
  }
  assertTeamBudget(state, target.id);
  const record = state.stageOne.latestValidBundle(target.id);
  if (record === undefined) {
    throw new MockApiError(409, "target_not_ready", "The target has no valid bundle", [
      { loc: ["bundle"], code: "bundle_missing", message: "Upload a valid bundle first" },
    ]);
  }
  if (!record.roles.some((role) => role.id === parsed.role)) {
    throw validationFailed([
      {
        loc: ["body", "role"],
        code: "value_error",
        message: `Value error, role ${parsed.role} is not in the bundle`,
      },
    ]);
  }
  const saved =
    parsed.goalId === null ? undefined : simulatorsOf(state).goals.find(parsed.goalId);
  if (parsed.goalId !== null && (saved === undefined || saved.target_id !== target.id)) {
    throw validationFailed([
      { loc: ["body", "goal_id"], code: "value_error", message: "Value error, goal not found" },
    ]);
  }
  const goalText = parsed.goalText ?? saved?.statement ?? "";
  const goalKind = saved?.kind ?? parsed.goalKind;
  const entry = launchRun(state, stageTwo(context), {
    kind: "explore",
    createdBy: user.id,
    targetId: target.id,
    planId: null,
    bundleId: record.bundle.id,
    readOnly: target.tier === "production",
    budget: parsed.budget,
    configSnapshot: buildConfigSnapshot(record, nowIso()),
    params: {
      goal_text: goalText,
      goal_kind: goalKind,
      role: parsed.role,
      max_steps: parsed.maxSteps,
    },
  });
  exploreStore.register({ runId: entry.run.id, goalText, role: parsed.role });
  return {
    run_id: entry.run.id,
    workflow_id: entry.run.workflow_id,
    kind: entry.run.kind,
    status: entry.run.status,
    created_at: entry.run.created_at,
  };
}

export function requestStop(context: ApiContext, user: MockUser, entry: RunEntry): void {
  const { run } = entry;
  const stoppable =
    !context.state.faults.runNotStoppable &&
    STOPPABLE_KINDS.includes(run.kind) &&
    !isTerminal(run.status) &&
    run.status !== "canceling";
  if (!stoppable) {
    throw conflict(
      "run_not_stoppable",
      `The ${run.kind} run is ${run.status} and cannot be stopped`,
    );
  }
  if (run.stop_requested_at !== null || isRunStopRequested(run.id)) {
    return;
  }
  markRunStopRequested(run.id);
  run.stop_requested_at = nowIso();
  context.state.appendRawEvent(entry.record, "run.stop_requested", { requested_by: user.id });
}
