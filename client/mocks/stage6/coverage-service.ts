import { annotateCoverageCells } from "../factories/annotations";
import { MockApiError, conflict, notFound, validationFailed } from "../factories/errors";
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
import type {
  AdapterKind,
  Budget,
  CellStatus,
  CoverageCell,
  CoverageMap,
  CoverageTotals,
  Depth,
  InterfaceMode,
  Plan,
  RunHandle,
} from "@/lib/api/types";
import { areaSlug, type CoverageCellState, type CoverageDataset } from "./coverage-data";
import { coverageStore, ensureBaselinePlan } from "./coverage-store";

export interface CoverageQuery {
  targetId: string;
  planId: string | null;
  bundleId: string | null;
  areas: readonly string[] | undefined;
  statuses: readonly CellStatus[] | undefined;
}

const DEPTHS: readonly Depth[] = ["smoke", "standard", "deep"];
const NON_GENERATABLE: readonly CellStatus[] = ["needs_author", "blocked"];
const EVERY_ROLE = "all";

function modeAccepts(mode: InterfaceMode, kind: AdapterKind): boolean {
  if (mode === "api_only") {
    return kind !== "browser";
  }
  return mode === "browser_only" ? kind === "browser" : true;
}

function cellsInPlan(dataset: CoverageDataset, plan: Plan): CoverageCellState[] {
  if (plan.is_coverage_baseline) {
    return dataset.cells;
  }
  const { selection } = plan;
  const featureIds = new Set(selection.feature_ids ?? []);
  const areaIds = new Set(selection.area_ids ?? []);
  const roles = selection.roles ?? [];
  const everyFeature = featureIds.size === 0 && areaIds.size === 0;
  const everyRole = roles.length === 0 || roles.includes(EVERY_ROLE);
  return dataset.cells.filter(
    (cell) =>
      (everyFeature || featureIds.has(cell.featureId) || areaIds.has(cell.area)) &&
      (everyRole || roles.includes(cell.role)) &&
      modeAccepts(selection.interface_mode, cell.interfaceKind),
  );
}

function toCoverageCell(cell: CoverageCellState, planId: string): CoverageCell {
  return {
    id: cell.id,
    plan_id: planId,
    feature_id: cell.featureId,
    role: cell.role,
    interface_id: cell.interfaceId,
    family: areaSlug(cell.area),
    status: cell.status,
    scenario_count: cell.scenarioCount,
    last_verdict: cell.lastVerdict,
    reason: cell.reason,
    skip_reason: cell.skipReason,
  };
}

function tally(cells: readonly CoverageCellState[]): CoverageTotals {
  const totals: CoverageTotals = {
    blocked: 0,
    covered: 0,
    empty: 0,
    generated: 0,
    needs_author: 0,
  };
  for (const cell of cells) {
    totals[cell.status] += 1;
  }
  return totals;
}

export function readCoverageMap(state: MockState, query: CoverageQuery): CoverageMap {
  const { stageOne, stageTwo: store } = state;
  const target = stageOne.findTarget(query.targetId);
  if (target === undefined) {
    throw notFound("Target not found");
  }
  const requested = query.planId === null ? undefined : store.findPlan(query.planId);
  if (query.planId !== null && (requested === undefined || requested.target_id !== target.id)) {
    throw notFound("Plan not found");
  }
  const record = resolveBundle(stageOne, target, requested?.bundle_id ?? query.bundleId);
  const dataset = coverageStore.datasetFor(target, record);
  const baseline = ensureBaselinePlan(store, target, record, dataset.cells.length);
  const shown = requested ?? baseline;
  const inPlan = cellsInPlan(dataset, shown);
  const cells = inPlan.filter(
    (cell) =>
      (query.areas === undefined || query.areas.includes(cell.area)) &&
      (query.statuses === undefined || query.statuses.includes(cell.status)),
  );
  const rowIds = new Set(cells.map((cell) => cell.featureId));
  const columnKeys = new Set(cells.map((cell) => `${cell.role}|${cell.interfaceId}`));
  return {
    target_id: target.id,
    plan_id: shown.id,
    bundle_id: record.bundle.id,
    rows: dataset.rows.filter((row) => rowIds.has(row.feature_id)),
    columns: dataset.columns
      .filter((column) => columnKeys.has(`${column.role}|${column.interface_id}`))
      .map((column) => ({ role: column.role, interface_id: column.interface_id })),
    cells: annotateCoverageCells(
      target.id,
      cells.map((cell) => toCoverageCell(cell, shown.id)),
    ),
    totals: tally(cells),
  };
}

export interface GenerateRequest {
  planId: string;
  cellIds: string[];
  depth: Depth;
  budget: Budget | undefined;
}

export function parseGenerateRequest(raw: Source): GenerateRequest {
  const reader = new BodyReader(raw);
  const planId = reader.uuid("plan_id", { required: true });
  const cellIds = reader.stringList("cell_ids", {});
  if (cellIds === undefined && !reader.has("cell_ids")) {
    reader.issue("cell_ids", "missing", "Field required");
  }
  const depth = reader.enum("depth", DEPTHS, { required: true });
  const details: ErrorDetail[] = [...reader.details];
  const budget = parseBudget(raw.budget, ["body", "budget"], details);
  if (cellIds !== undefined && cellIds !== null && cellIds.length === 0) {
    details.push({
      loc: ["body", "cell_ids"],
      code: "too_short",
      message: "List should have at least 1 item after validation, not 0",
    });
  }
  const normalized = (cellIds ?? []).map((id) => id.toLowerCase());
  normalized.forEach((id, index) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      details.push({
        loc: ["body", "cell_ids", index],
        code: "uuid_parsing",
        message: "Input should be a valid UUID",
      });
    }
  });
  if (details.length > 0) {
    throw validationFailed(details);
  }
  return {
    planId: planId as string,
    cellIds: [...new Set(normalized)],
    depth: depth as Depth,
    budget,
  };
}

export function productionBlocked(targetName: string): MockApiError {
  return new MockApiError(
    409,
    "production_blocked",
    `${targetName} is a production target; scenarios are not generated against it`,
    [
      {
        loc: ["target", "tier"],
        code: "production_blocked",
        message: "Generation is blocked on production targets",
      },
    ],
  );
}

export interface GenerationParams {
  plan_id: string;
  cell_ids: string[];
  depth: Depth;
  mode: "generate" | "dry_run";
}

export function readGenerationParams(params: Record<string, unknown>): GenerationParams {
  const cellIds = Array.isArray(params.cell_ids)
    ? params.cell_ids.filter((id): id is string => typeof id === "string")
    : [];
  return {
    plan_id: typeof params.plan_id === "string" ? params.plan_id : "",
    cell_ids: cellIds,
    depth: DEPTHS.find((depth) => depth === params.depth) ?? "smoke",
    mode: params.mode === "dry_run" ? "dry_run" : "generate",
  };
}

export function startGeneration(
  state: MockState,
  user: MockUser,
  request: GenerateRequest,
): RunHandle {
  const { stageOne, stageTwo: store } = state;
  const plan = store.findPlan(request.planId);
  if (plan === undefined) {
    throw notFound("Plan not found");
  }
  const target = stageOne.findTarget(plan.target_id);
  if (target === undefined) {
    throw notFound("Target not found");
  }
  if (target.archivedAt !== null) {
    throw conflict("conflict", "The target is archived");
  }
  if (target.tier === "production" || state.faults.productionTarget) {
    throw productionBlocked(target.name);
  }
  assertTeamBudget(state, target.id);
  const record = resolveBundle(stageOne, target, plan.bundle_id);
  const dataset = coverageStore.datasetFor(target, record);
  const details: ErrorDetail[] = [];
  request.cellIds.forEach((cellId, index) => {
    const cell = dataset.cells.find((candidate) => candidate.id === cellId);
    if (cell === undefined) {
      details.push({
        loc: ["body", "cell_ids", index],
        code: "cell_not_found",
        message: "This cell is not part of the plan",
      });
    } else if (NON_GENERATABLE.includes(cell.status)) {
      details.push({
        loc: ["body", "cell_ids", index],
        code: "cell_not_generatable",
        message:
          cell.status === "blocked"
            ? "This cell is blocked, so nothing can be generated for it"
            : "This cell needs an authored scenario; use the Author prompt",
      });
    }
  });
  if (details.length > 0) {
    throw validationFailed(details);
  }
  const params: GenerationParams = {
    plan_id: plan.id,
    cell_ids: request.cellIds,
    depth: request.depth,
    mode: "generate",
  };
  const entry = launchRun(state, store, {
    kind: "generate",
    createdBy: user.id,
    targetId: target.id,
    planId: plan.id,
    bundleId: record.bundle.id,
    readOnly: false,
    budget: request.budget ?? { ...DEFAULT_RUN_BUDGET },
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
