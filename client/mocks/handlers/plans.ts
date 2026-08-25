import { http } from "msw";
import { conflict, notFound, validationFailed } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { BodyReader } from "../stage1/body";
import { hashParts, pathUuid, withIdempotency } from "../stage1/support";
import { cellsOfPlan } from "../stage2/plan-cells";
import {
  buildPlan,
  evaluatePlan,
  parsePlanCreate,
  parsePlanSelection,
  PLAN_NAME_MAX,
  planAsCreate,
  planEmpty,
  toPreview,
} from "../stage2/plan-service";
import { CELL_STATUSES, nowIso, stageTwo } from "../stage2/support";
import type { CoverageCell, Plan, PlanSelection } from "@/lib/api/types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const PLAN_PAGE: PageSpec<Plan> = {
  sortKeys: { created_at: { kind: "timestamp", value: (row) => row.created_at } },
  defaultSort: "-created_at",
  getId: (row) => row.id,
};

const CELL_PAGE: PageSpec<CoverageCell> = {
  sortKeys: {
    feature_id: { kind: "text", value: (row) => row.feature_id },
    role: { kind: "text", value: (row) => row.role },
    interface_id: { kind: "text", value: (row) => row.interface_id },
    status: { kind: "text", value: (row) => row.status },
  },
  defaultSort: "feature_id,role,interface_id",
  getId: (row) => row.id,
};

function clonePlan(plan: Plan): Plan {
  return structuredClone(plan);
}

function requirePlan(context: ApiContext): Plan {
  const plan = stageTwo(context).findPlan(pathUuid(context, "plan_id"));
  if (plan === undefined) {
    throw notFound("Plan not found");
  }
  return plan;
}

async function previewPlan(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const parsed = parsePlanCreate(parseJsonObject(await context.request.text()));
  return jsonResponse(
    toPreview(evaluatePlan(context.state, parsed), {
      depth: parsed.selection.depth,
      includeApiFuzz: parsed.includeApiFuzz === true,
    }),
  );
}

async function createPlan(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const raw = await context.request.text();
  const parsed = parsePlanCreate(parseJsonObject(raw));
  return withIdempotency(
    context,
    user,
    { required: false, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => {
      const evaluation = evaluatePlan(context.state, parsed);
      if (evaluation.target.archivedAt !== null) {
        throw conflict("conflict", "The target is archived");
      }
      if (evaluation.expansion.cells.length === 0) {
        throw planEmpty();
      }
      const store = stageTwo(context);
      const plan = buildPlan(store, parsed, evaluation, user.id, nowIso());
      store.addPlan(plan);
      return { status: 201, body: clonePlan(plan) };
    },
  );
}

async function listPlans(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id");
  const savedText = query.text("saved");
  const saved = savedText === undefined ? undefined : query.boolean("saved", false);
  const paginate = readPage(query, PLAN_PAGE);
  query.finish();
  const rows = stageTwo(context)
    .plans.filter((plan) => !plan.is_coverage_baseline)
    .filter((plan) => targetId === undefined || plan.target_id === targetId.toLowerCase())
    .filter((plan) => saved === undefined || plan.saved === saved)
    .map(clonePlan);
  return jsonResponse(paginate(rows));
}

async function readPlan(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  return jsonResponse(clonePlan(requirePlan(context)));
}

async function updatePlan(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const plan = requirePlan(context);
  const raw = parseJsonObject(await context.request.text());
  const reader = new BodyReader(raw);
  const name = reader.string("name", {
    required: false,
    nullable: true,
    min: 1,
    max: PLAN_NAME_MAX,
    strip: true,
  });
  if (reader.details.length > 0) {
    throw validationFailed(reader.details);
  }
  let selection: PlanSelection | undefined;
  if (raw.selection !== undefined && raw.selection !== null) {
    selection = parsePlanSelection(raw.selection, ["body", "selection"]);
  }
  if (selection !== undefined) {
    const evaluation = evaluatePlan(context.state, {
      ...planAsCreate(plan),
      selection,
    });
    if (evaluation.expansion.cells.length === 0) {
      throw planEmpty();
    }
    plan.selection = selection;
    plan.effective_budget = { ...evaluation.budget };
    plan.cells_total = evaluation.expansion.cells.length;
  }
  if (name !== undefined) {
    plan.name = name;
  }
  return jsonResponse(clonePlan(plan));
}

async function deletePlan(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const plan = requirePlan(context);
  stageTwo(context).removePlan(plan.id);
  return new Response(null, { status: 204 });
}

async function listPlanCells(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const plan = requirePlan(context);
  const query = new QueryReader(context.url.searchParams);
  const statuses = query.enumList("status", CELL_STATUSES);
  const featureIds = query.stringList("feature_id");
  const paginate = readPage(query, CELL_PAGE);
  query.finish();
  const rows = cellsOfPlan(context.state, plan)
    .filter((cell) => statuses === undefined || statuses.includes(cell.status))
    .filter((cell) => featureIds === undefined || featureIds.includes(cell.feature_id));
  return jsonResponse(paginate(rows));
}

export const planHandlers = [
  http.post("*/api/v1/plans/preview", api(previewPlan)),
  http.post("*/api/v1/plans", api(createPlan)),
  http.get("*/api/v1/plans", api(listPlans)),
  http.get("*/api/v1/plans/:plan_id/cells", api(listPlanCells)),
  http.get("*/api/v1/plans/:plan_id", api(readPlan)),
  http.patch("*/api/v1/plans/:plan_id", api(updatePlan)),
  http.delete("*/api/v1/plans/:plan_id", api(deletePlan)),
];
