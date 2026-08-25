import { conflict, MockApiError, notFound, validationFailed } from "../factories/errors";
import { launchRun } from "../server/run-simulator";
import { assertTeamBudget } from "../stage10/teams-guard";
import { BodyReader, type Source } from "../stage1/body";
import {
  buildConfigSnapshot,
  DEFAULT_RUN_BUDGET,
  parseBudget,
  resolveBundle,
} from "../stage2/plan-service";
import { nowIso } from "../stage2/support";
import type { MockState } from "../state";
import type { ErrorDetail, MockUser } from "../types";
import type { Budget, RunHandle } from "@/lib/api/types";
import { REDTEAM_FAMILIES } from "./redteam-data";

export const REDTEAM_MAX_ROUNDS_LIMIT = 50;
export const SKEPTIC_NOT_INDEPENDENT = "skeptic_not_independent";

export interface RedTeamRequest {
  targetId: string;
  role: string;
  families: string[];
  maxRounds: number | null;
  budget: Budget;
}

export interface RedteamRunParams {
  target_id: string;
  role: string;
  families: string[];
  max_rounds: number | null;
}

export function parseRedTeamCreate(raw: Source): RedTeamRequest {
  const reader = new BodyReader(raw);
  const targetId = reader.uuid("target_id", { required: true });
  const role = reader.string("role", { required: true, min: 1, max: 100, strip: true });
  const families = reader.stringList("families", { maxItems: REDTEAM_FAMILIES.length });
  if (families === undefined && !reader.has("families")) {
    reader.issue("families", "missing", "Field required");
  }
  const maxRounds = readMaxRounds(reader, raw);
  const details: ErrorDetail[] = [...reader.details];
  const budget = parseBudget(raw.budget, ["body", "budget"], details);
  if (budget === undefined && raw.budget === undefined) {
    details.push({ loc: ["body", "budget"], code: "missing", message: "Field required" });
  }
  if (families !== undefined && families !== null && families.length === 0) {
    details.push({
      loc: ["body", "families"],
      code: "too_short",
      message: "List should have at least 1 item after validation, not 0",
    });
  }
  if (details.length > 0) {
    throw validationFailed(details);
  }
  return {
    targetId: targetId as string,
    role: role as string,
    families: [...new Set(families ?? [])],
    maxRounds,
    budget: budget ?? { ...DEFAULT_RUN_BUDGET },
  };
}

function readMaxRounds(reader: BodyReader, raw: Source): number | null {
  const value = raw.max_rounds;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    reader.issue("max_rounds", "int_type", "Input should be a valid integer");
    return null;
  }
  if (value < 1 || value > REDTEAM_MAX_ROUNDS_LIMIT) {
    reader.issue(
      "max_rounds",
      value < 1 ? "greater_than_equal" : "less_than_equal",
      value < 1
        ? "Input should be greater than or equal to 1"
        : `Input should be less than or equal to ${REDTEAM_MAX_ROUNDS_LIMIT}`,
    );
    return null;
  }
  return value;
}

export function isProductionBlocked(state: MockState, tier: string): boolean {
  return tier === "production" || state.faults.productionTarget || state.faults.productionBlocked;
}

export function productionBlockedFor(targetName: string, activity: string): MockApiError {
  return new MockApiError(
    409,
    "production_blocked",
    `${targetName} is a production target; ${activity} are never run against it`,
    [
      {
        loc: ["target", "tier"],
        code: "production_blocked",
        message: `${activity} are blocked on production targets`,
      },
    ],
  );
}

export function readRedteamParams(params: Record<string, unknown>): RedteamRunParams {
  const families = Array.isArray(params.families)
    ? params.families.filter((id): id is string => typeof id === "string")
    : [];
  const maxRounds = typeof params.max_rounds === "number" ? params.max_rounds : null;
  return {
    target_id: typeof params.target_id === "string" ? params.target_id : "",
    role: typeof params.role === "string" ? params.role : "guest",
    families: families.length > 0 ? families : REDTEAM_FAMILIES.slice(0, 3).map((item) => item.id),
    max_rounds: maxRounds,
  };
}

export function startRedTeam(
  state: MockState,
  user: MockUser,
  request: RedTeamRequest,
): RunHandle {
  const { stageOne, stageTwo: store } = state;
  const target = stageOne.findTarget(request.targetId);
  if (target === undefined) {
    throw notFound("Target not found");
  }
  if (target.archivedAt !== null) {
    throw conflict("conflict", "The target is archived");
  }
  if (isProductionBlocked(state, target.tier)) {
    throw productionBlockedFor(target.name, "red team runs");
  }
  assertTeamBudget(state, target.id);
  const known = new Set(REDTEAM_FAMILIES.map((family) => family.id));
  const details: ErrorDetail[] = [];
  request.families.forEach((id, index) => {
    if (!known.has(id)) {
      details.push({
        loc: ["body", "families", index],
        code: "unknown_family",
        message: `'${id}' is not an attack family; read the list from GET /redteam/families`,
      });
    }
  });
  if (details.length > 0) {
    throw validationFailed(details);
  }
  if (state.faults.skepticNotIndependent) {
    throw validationFailed([
      {
        loc: ["body", "families"],
        code: SKEPTIC_NOT_INDEPENDENT,
        message: "The skeptic model must differ from the attack model",
      },
    ]);
  }
  const record = resolveBundle(stageOne, target, null);
  const params: RedteamRunParams = {
    target_id: target.id,
    role: request.role,
    families: request.families,
    max_rounds: request.maxRounds,
  };
  const entry = launchRun(state, store, {
    kind: "redteam",
    createdBy: user.id,
    targetId: target.id,
    planId: null,
    bundleId: record.bundle.id,
    readOnly: false,
    budget: request.budget,
    configSnapshot: buildConfigSnapshot(record, nowIso()),
    params: { ...params },
  });
  return {
    run_id: entry.run.id,
    workflow_id: entry.run.workflow_id,
    kind: entry.run.kind,
    status: entry.run.status,
    created_at: entry.run.created_at,
  };
}
