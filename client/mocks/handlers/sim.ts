import { http } from "msw";
import { MockApiError, notFound, validationFailed } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { launchRun } from "../server/run-simulator";
import { assertTeamBudget } from "../stage10/teams-guard";
import {
  hashParts,
  pathUuid,
  requireActiveTarget,
  requireIdempotencyKey,
  withIdempotency,
} from "../stage1/support";
import type { TargetRecord } from "../stage1/store";
import { buildConfigSnapshot } from "../stage2/plan-service";
import { stageTwo, VERDICT_STATUSES } from "../stage2/support";
import { ensureSimulationHistory } from "../stage7/sim-history";
import { parseSimulationCreate } from "../stage7/sim-requests";
import { simulatorsOf, type StoredSimSession } from "../stage7/sim-store";
import { simulationParams } from "../streams/simulate-script";
import type { RunHandle } from "@/lib/api/types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const SESSION_PAGE: PageSpec<StoredSimSession> = {
  sortKeys: {
    created_at: { kind: "number", value: (row) => row.order },
    attempt: { kind: "number", value: (row) => row.session.attempt },
  },
  defaultSort: "-created_at",
  getId: (row) => row.session.id,
};

function productionBlocked(target: TargetRecord): MockApiError {
  return new MockApiError(
    409,
    "production_blocked",
    `${target.name} is a production target; simulated users are never run against it`,
    [
      {
        loc: ["target", "tier"],
        code: "production_blocked",
        message: "Simulations write to the target and are always blocked on production",
      },
    ],
  );
}

function bundleMissing(): MockApiError {
  const message = "The target has no valid bundle to simulate against";
  return new MockApiError(409, "target_not_ready", message, [
    { loc: ["bundle"], code: "bundle_missing", message },
  ]);
}

function missingReference(field: "persona_id" | "goal_id", label: string) {
  return validationFailed([
    {
      loc: ["body", field],
      code: `${field === "persona_id" ? "persona" : "goal"}_not_found`,
      message: `${label} not found for this target`,
    },
  ]);
}

async function createSimulation(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  requireIdempotencyKey(context);
  const raw = await context.request.text();
  const request = parseSimulationCreate(parseJsonObject(raw));
  return withIdempotency(
    context,
    user,
    { required: true, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => {
      const target = requireActiveTarget(context, request.targetId);
      if (target.tier === "production" || context.state.faults.productionTarget) {
        throw productionBlocked(target);
      }
      assertTeamBudget(context.state, target.id);
      const simulators = simulatorsOf(context.state);
      const persona = simulators.personas.find(request.personaId);
      if (persona === undefined || persona.target_id !== target.id) {
        throw missingReference("persona_id", "Persona");
      }
      const goal = simulators.goals.find(request.goalId);
      if (goal === undefined || goal.target_id !== target.id) {
        throw missingReference("goal_id", "Goal");
      }
      const bundle = context.state.stageOne.latestValidBundle(target.id);
      if (bundle === undefined) {
        throw bundleMissing();
      }
      ensureSimulationHistory(context.state);
      const entry = launchRun(context.state, stageTwo(context), {
        kind: "simulate",
        createdBy: user.id,
        targetId: target.id,
        planId: null,
        bundleId: bundle.bundle.id,
        readOnly: false,
        budget: request.budget,
        configSnapshot: buildConfigSnapshot(bundle, new Date().toISOString()),
        params: simulationParams({
          personaId: persona.id,
          goalId: goal.id,
          role: request.role,
          attempts: request.k,
        }),
      });
      const handle: RunHandle = {
        run_id: entry.run.id,
        workflow_id: entry.run.workflow_id,
        kind: entry.run.kind,
        status: entry.run.status,
        created_at: entry.run.created_at,
      };
      return { status: 202, body: handle };
    },
  );
}

async function listSessions(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const runId = query.uuid("run_id");
  const personaId = query.uuid("persona_id");
  const goalId = query.uuid("goal_id");
  const verdicts = query.enumList("verdict", VERDICT_STATUSES);
  const paginate = readPage(query, SESSION_PAGE);
  query.finish();
  ensureSimulationHistory(context.state);
  const rows = simulatorsOf(context.state).sessions.filter(
    ({ session }) =>
      (runId === undefined || session.run_id === runId.toLowerCase()) &&
      (personaId === undefined || session.persona_id === personaId.toLowerCase()) &&
      (goalId === undefined || session.goal_id === goalId.toLowerCase()) &&
      (verdicts === undefined || verdicts.includes(session.verdict.status)),
  );
  const page = paginate(rows);
  return jsonResponse({ ...page, items: page.items.map((row) => row.session) });
}

async function readSession(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const sessionId = pathUuid(context, "sim_session_id");
  ensureSimulationHistory(context.state);
  const session = simulatorsOf(context.state).findSession(sessionId);
  if (session === undefined) {
    throw notFound("Simulation session not found");
  }
  return jsonResponse(session);
}

export const simHandlers = [
  http.post("*/api/v1/simulations", api(createSimulation)),
  http.get("*/api/v1/sim-sessions", api(listSessions)),
  http.get("*/api/v1/sim-sessions/:sim_session_id", api(readSession)),
];
