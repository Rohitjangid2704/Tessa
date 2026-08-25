import { http } from "msw";
import { notFound } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { pathUuid } from "../stage1/support";
import { cellKey } from "../stage2/expand";
import { cellsOfPlan } from "../stage2/plan-cells";
import { SCENARIO_ORIGINS, SCENARIO_STATUSES, stageTwo } from "../stage2/support";
import type { ScenarioRecord } from "../stage2/types";
import { toScenario, toScenarioSummary } from "../stage2/views";
import { ensureCellScenarios } from "../stage6/cell-scenarios";
import { scenarioEdits } from "../stage6/scenario-edit-store";
import type { ScenarioSummary } from "@/lib/api/types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const SEARCH_MAX = 200;

const SCENARIO_PAGE: PageSpec<ScenarioSummary> = {
  sortKeys: {
    created_at: { kind: "timestamp", value: (row) => row.created_at },
    updated_at: { kind: "timestamp", value: (row) => row.updated_at },
    title: { kind: "text", value: (row) => row.title },
  },
  defaultSort: "-created_at",
  getId: (row) => row.id,
};

function cellKeysOfPlan(context: ApiContext, planId: string): Set<string> | null {
  const plan = stageTwo(context).findPlan(planId);
  if (plan === undefined) {
    return null;
  }
  return new Set(
    cellsOfPlan(context.state, plan).map((cell) =>
      cellKey(cell.feature_id, cell.role, cell.interface_id),
    ),
  );
}

function keyOfCellId(context: ApiContext, cellId: string): string | null {
  for (const plan of stageTwo(context).plans) {
    const match = cellsOfPlan(context.state, plan).find((cell) => cell.id === cellId);
    if (match !== undefined) {
      return cellKey(match.feature_id, match.role, match.interface_id);
    }
  }
  return null;
}

async function listScenarios(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id");
  const statuses = query.enumList("status", SCENARIO_STATUSES);
  const origins = query.enumList("origin", SCENARIO_ORIGINS);
  const families = query.stringList("family");
  const featureIds = query.stringList("feature_id");
  const cellId = query.uuid("cell_id");
  const planId = query.uuid("plan_id");
  const text = query.text("q", { max: SEARCH_MAX })?.trim().toLowerCase();
  const includeSynthetic = query.boolean("include_synthetic", false);
  const replayId = query.uuid("replay_id");
  const paginate = readPage(query, SCENARIO_PAGE);
  query.finish();
  if (cellId !== undefined) {
    ensureCellScenarios(context.state, cellId.toLowerCase());
  }

  const planKeys = planId === undefined ? undefined : cellKeysOfPlan(context, planId.toLowerCase());
  const cellKey = cellId === undefined ? undefined : keyOfCellId(context, cellId.toLowerCase());
  const matches = (entry: ScenarioRecord): boolean => {
    const { scenario } = entry;
    return (
      (includeSynthetic || !scenario.synthetic) &&
      (replayId === undefined ||
        scenarioEdits(context.state).provenanceOf(entry).replay_id === replayId.toLowerCase()) &&
      (targetId === undefined || scenario.target_id === targetId.toLowerCase()) &&
      (statuses === undefined || statuses.includes(scenario.status)) &&
      (origins === undefined || origins.includes(scenario.origin)) &&
      (families === undefined || families.includes(scenario.family)) &&
      (featureIds === undefined ||
        (scenario.feature_id !== null && featureIds.includes(scenario.feature_id))) &&
      (planId === undefined ||
        (planKeys !== undefined &&
          planKeys !== null &&
          entry.cellKey !== null &&
          planKeys.has(entry.cellKey))) &&
      (cellId === undefined ||
        scenario.cell_id === cellId.toLowerCase() ||
        (cellKey !== null && cellKey !== undefined && entry.cellKey === cellKey)) &&
      (text === undefined ||
        scenario.title.toLowerCase().includes(text) ||
        (scenario.feature_id ?? "").toLowerCase().includes(text) ||
        scenario.family.toLowerCase().includes(text) ||
        scenario.id.includes(text))
    );
  };
  const rows = stageTwo(context)
    .scenarios.filter(matches)
    .map((entry) => toScenarioSummary(entry.scenario));
  return jsonResponse(paginate(rows));
}

async function readScenario(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const entry = stageTwo(context).findScenario(pathUuid(context, "scenario_id"));
  if (entry === undefined) {
    throw notFound("Scenario not found");
  }
  return jsonResponse(toScenario(entry.scenario));
}

export const scenarioHandlers = [
  http.get("*/api/v1/scenarios", api(listScenarios)),
  http.get("*/api/v1/scenarios/:scenario_id", api(readScenario)),
];
