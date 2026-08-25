import { http } from "msw";
import { MockApiError, notFound } from "../factories/errors";
import { newId } from "../factories/ids";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { hashParts, pathUuid, requireActiveTarget, withIdempotency } from "../stage1/support";
import { ensureSimulationHistory } from "../stage7/sim-history";
import {
  GOAL_KINDS,
  parseGoalCreate,
  parseGoalUpdate,
  SEARCH_MAX,
} from "../stage7/sim-requests";
import { simulatorsOf } from "../stage7/sim-store";
import type { Goal } from "@/lib/api/types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const GOAL_PAGE: PageSpec<Goal> = {
  sortKeys: { title: { kind: "text", value: (row) => row.title } },
  defaultSort: "title",
  getId: (row) => row.id,
};

function duplicateTitle(): MockApiError {
  const message = "A goal with this title already exists for the target";
  return new MockApiError(409, "conflict", message, [
    { loc: ["body", "title"], code: "already_exists", message },
  ]);
}

function goalInUse(): MockApiError {
  return new MockApiError(
    409,
    "conflict",
    "This goal is used by simulation sessions and cannot be deleted",
    [
      {
        loc: ["path", "goal_id"],
        code: "in_use",
        message: "Sessions of past simulations still refer to this goal",
      },
    ],
  );
}

async function listGoals(context: ApiContext): Promise<Response> {
  ensureSimulationHistory(context.state);
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id");
  const kinds = query.enumList("kind", GOAL_KINDS);
  const text = query.text("q", { max: SEARCH_MAX });
  const paginate = readPage(query, GOAL_PAGE);
  query.finish();
  const needle = text?.toLowerCase();
  const rows = simulatorsOf(context.state).goals.goals.filter(
    (goal) =>
      (targetId === undefined || goal.target_id === targetId.toLowerCase()) &&
      (kinds === undefined || kinds.includes(goal.kind)) &&
      (needle === undefined ||
        goal.title.toLowerCase().includes(needle) ||
        goal.statement.toLowerCase().includes(needle)),
  );
  return jsonResponse(paginate(rows));
}

async function createGoal(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const raw = await context.request.text();
  const input = parseGoalCreate(parseJsonObject(raw));
  return withIdempotency(
    context,
    user,
    { required: false, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => {
      const target = requireActiveTarget(context, input.target_id);
      const { goals } = simulatorsOf(context.state);
      if (goals.titleTaken(target.id, input.title)) {
        throw duplicateTitle();
      }
      const goal: Goal = {
        id: newId(),
        target_id: target.id,
        title: input.title,
        kind: input.kind,
        statement: input.statement,
        success_criteria: input.success_criteria,
        role: input.role,
      };
      goals.add(goal);
      return { status: 201, body: goal };
    },
  );
}

function requireGoal(context: ApiContext): Goal {
  const goal = simulatorsOf(context.state).goals.find(pathUuid(context, "goal_id"));
  if (goal === undefined) {
    throw notFound("Goal not found");
  }
  return goal;
}

async function readGoal(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  return jsonResponse(requireGoal(context));
}

async function updateGoal(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const current = requireGoal(context);
  const change = parseGoalUpdate(parseJsonObject(await context.request.text()));
  const { goals } = simulatorsOf(context.state);
  if (change.title !== undefined && goals.titleTaken(current.target_id, change.title, current.id)) {
    throw duplicateTitle();
  }
  const updated: Goal = { ...current, ...change };
  goals.replace(updated);
  return jsonResponse(updated);
}

async function deleteGoal(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const current = requireGoal(context);
  const simulators = simulatorsOf(context.state);
  if (simulators.goalInUse(current.id)) {
    throw goalInUse();
  }
  simulators.goals.remove(current.id);
  return new Response(null, { status: 204 });
}

export const goalHandlers = [
  http.get("*/api/v1/goals", api(listGoals)),
  http.post("*/api/v1/goals", api(createGoal)),
  http.get("*/api/v1/goals/:goal_id", api(readGoal)),
  http.patch("*/api/v1/goals/:goal_id", api(updateGoal)),
  http.delete("*/api/v1/goals/:goal_id", api(deleteGoal)),
];
