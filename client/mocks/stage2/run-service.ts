import { MockApiError, conflict, notFound, validationFailed } from "../factories/errors";
import { launchSuiteRun } from "../simulation/suite-launch";
import { assertTeamBudget } from "../stage10/teams-guard";
import { BodyReader, type Source } from "../stage1/body";
import type { MockState } from "../state";
import type { MockUser } from "../types";
import type { Budget, Plan, RunHandle, RunTrigger } from "@/lib/api/types";
import {
  buildPlan,
  evaluatePlan,
  missingRequiredVariables,
  notReady,
  parsePlanCreate,
  planAsCreate,
  planEmpty,
  type ParsedPlanCreate,
} from "./plan-service";
import { nowIso } from "./support";
import { resolveSubset, type SubsetSelection } from "../stage11/subset-run";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUBSET_SCENARIOS = 50;

function readScenarioIds(body: Source, reader: BodyReader): string[] | null {
  const raw = body.scenario_ids;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!Array.isArray(raw)) {
    reader.issue("scenario_ids", "list_type", "Input should be a valid list");
    return null;
  }
  if (raw.length < 1 || raw.length > MAX_SUBSET_SCENARIOS) {
    reader.issue(
      "scenario_ids",
      raw.length < 1 ? "too_short" : "too_long",
      `List should have between 1 and ${MAX_SUBSET_SCENARIOS} items`,
    );
    return null;
  }
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      reader.issue("scenario_ids", "uuid_parsing", "Input should be a valid UUID");
      return null;
    }
    ids.push(value.toLowerCase());
  }
  return ids;
}

export interface ParsedRunCreate {
  planId: string | null;
  plan: ParsedPlanCreate | null;
  scenarioIds?: string[] | null;
  targetId?: string | null;
  maxConcurrency: number | null;
  resetSeed: boolean;
}

export function parseRunCreate(body: Source): ParsedRunCreate {
  const reader = new BodyReader(body);
  const planId = reader.uuid("plan_id", { required: false, nullable: true });
  const hasPlan = body.plan !== undefined && body.plan !== null;
  const scenarioIds = readScenarioIds(body, reader);
  const targetId = reader.uuid("target_id", { required: false, nullable: true });
  const concurrencyRaw = body.max_concurrency;
  let maxConcurrency: number | null = null;
  if (concurrencyRaw !== undefined && concurrencyRaw !== null) {
    if (typeof concurrencyRaw !== "number" || !Number.isInteger(concurrencyRaw)) {
      reader.issue("max_concurrency", "int_type", "Input should be a valid integer");
    } else if (concurrencyRaw < 1) {
      reader.issue(
        "max_concurrency",
        "greater_than_equal",
        "Input should be greater than or equal to 1",
      );
    } else {
      maxConcurrency = concurrencyRaw;
    }
  }
  const resetSeed = reader.boolean("reset_seed", { nullable: true });
  const details = [...reader.details];
  const sources =
    (planId === undefined || planId === null ? 0 : 1) +
    (hasPlan ? 1 : 0) +
    (scenarioIds === null ? 0 : 1);
  if (details.length === 0 && sources !== 1) {
    details.push({
      loc: ["body"],
      code: "value_error",
      message: "Value error, send exactly one of plan_id, plan and scenario_ids",
    });
  }
  if (
    details.length === 0 &&
    scenarioIds !== null &&
    (targetId === undefined || targetId === null)
  ) {
    details.push({
      loc: ["body", "target_id"],
      code: "value_error",
      message: "Value error, scenario_ids needs target_id",
    });
  }
  let plan: ParsedPlanCreate | null = null;
  if (details.length === 0 && hasPlan) {
    const inline = typeof body.plan === "object" && !Array.isArray(body.plan) ? body.plan : null;
    if (inline === null) {
      details.push({
        loc: ["body", "plan"],
        code: "model_attributes_type",
        message: "Input should be a valid dictionary or object to extract fields from",
      });
    } else {
      plan = parsePlanCreate(Object.fromEntries(Object.entries(inline)), ["body", "plan"]);
    }
  }
  if (details.length > 0) {
    throw validationFailed(details);
  }
  return {
    planId: planId ?? null,
    plan,
    scenarioIds,
    targetId: targetId ?? null,
    maxConcurrency,
    resetSeed: resetSeed === true,
  };
}

export interface SuiteRunOptions {
  trigger?: RunTrigger;
  budget?: Budget;
}

export function startSuiteRun(
  state: MockState,
  user: MockUser,
  parsed: ParsedRunCreate,
  options: SuiteRunOptions = {},
): RunHandle {
  const { stageTwo: store } = state;
  let stored: Plan | undefined;
  let create: ParsedPlanCreate;
  let subset: SubsetSelection | null = null;
  if (parsed.scenarioIds !== undefined && parsed.scenarioIds !== null) {
    subset = resolveSubset(state, parsed.targetId as string, parsed.scenarioIds);
    create = subset.create;
  } else if (parsed.planId !== null) {
    stored = store.findPlan(parsed.planId);
    if (stored === undefined) {
      throw notFound("Plan not found");
    }
    create = planAsCreate(stored);
  } else {
    create = { ...(parsed.plan as ParsedPlanCreate), saved: false };
  }
  const fullEvaluation = evaluatePlan(state, create);
  const evaluation =
    subset === null
      ? fullEvaluation
      : {
          ...fullEvaluation,
          expansion: {
            ...fullEvaluation.expansion,
            cells: fullEvaluation.expansion.cells.filter(
              (cell) => subset.cellKeys.has(cell.key) || subset.featureIds.has(cell.featureId),
            ),
          },
        };
  const { target, record, expansion } = evaluation;
  if (target.archivedAt !== null) {
    throw conflict("conflict", "The target is archived");
  }
  if (target.tier === "production" && !target.allowProduction) {
    throw new MockApiError(
      409,
      "production_blocked",
      `${target.name} is a production target and does not allow runs yet`,
      [
        {
          loc: ["target", "allow_production"],
          code: "production_blocked",
          message: "An admin must enable allow_production for this target",
        },
      ],
    );
  }
  if (expansion.cells.length === 0) {
    throw planEmpty();
  }
  const missing = missingRequiredVariables(state.stageOne, target.id, expansion.cells);
  if (missing.length > 0) {
    throw notReady(
      missing.map((name) => ({
        loc: ["environment", name],
        code: "env_missing",
        message: `Required variable ${name} has no value`,
      })),
      `${missing.length} required environment variable${missing.length === 1 ? " has" : "s have"} no value`,
    );
  }
  assertTeamBudget(state, target.id);
  const plan = stored ?? buildPlan(store, create, evaluation, user.id, nowIso());
  if (stored === undefined) {
    store.addPlan(plan);
  }
  const entry = launchSuiteRun({
    state,
    store,
    createdBy: user.id,
    target,
    record,
    planId: plan.id,
    attempts: plan.selection.k,
    budget: options.budget ?? plan.effective_budget,
    trigger: options.trigger,
    cells: expansion.cells,
    readOnly: target.tier === "production",
    concurrency: parsed.maxConcurrency ?? undefined,
    resetSeed: parsed.resetSeed,
    scenarioIds: subset?.scenarioIds,
    budgetExhausted: state.faults.consume("budget_exhausted"),
    verdictFlaky: state.faults.verdictFlaky,
  });
  return {
    run_id: entry.run.id,
    workflow_id: entry.run.workflow_id,
    kind: entry.run.kind,
    status: entry.run.status,
    created_at: entry.run.created_at,
  };
}
