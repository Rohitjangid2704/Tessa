import type { CatalogItem } from "../factories/catalog";
import { MockApiError, notFound, validationFailed } from "../factories/errors";
import { BodyReader, type Loc, type Source } from "../stage1/body";
import type { BundleRecord, StageOneStore, TargetRecord } from "../stage1/store";
import type { MockState } from "../state";
import type { ErrorDetail } from "../types";
import type {
  Budget,
  Depth,
  Plan,
  PlanExtended,
  PlanPreview,
  PlanSelection,
  RunConfigSnapshot,
} from "@/lib/api/types";
import { expandSelection, runnableCellCount, type ExpandedCell, type Expansion } from "./expand";
import { stableId } from "./ids";
import { buildSmokeScenario, plusSeconds } from "./scenario-factory";
import type { StageTwoStore } from "./store";
import type { ScenarioRecord } from "./types";

export const DEFAULT_RUN_BUDGET: Budget = { max_usd: 5, max_minutes: 30 };
export const PLAN_MAX_K = 10;
export const PLAN_NAME_MAX = 120;

const INTERFACE_MODES = ["api_only", "browser_only", "both"] as const;
const DEPTHS = ["smoke", "standard", "deep"] as const;
const ESTIMATE_COST_PER_CELL_USD = 0.1;
const OPENAPI_FILE = "openapi.json";

export interface ParsedPlanCreate {
  targetId: string;
  bundleId: string | null;
  name: string | null;
  saved: boolean;
  selection: PlanSelection;
  includeApiFuzz?: boolean;
}

export interface PreviewOptions {
  depth: Depth;
  includeApiFuzz: boolean;
}

export interface Evaluation {
  target: TargetRecord;
  record: BundleRecord;
  expansion: Expansion;
  budget: Budget;
}

interface NumberRules {
  integer: boolean;
  exclusiveMin?: number;
  min?: number;
  max?: number;
}

function throwIfAny(details: ErrorDetail[]): void {
  if (details.length > 0) {
    throw validationFailed(details);
  }
}

function asObject(raw: unknown): Source | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw))
    : null;
}

function readNumber(
  reader: BodyReader,
  source: Source,
  field: string,
  rules: NumberRules,
): number | undefined {
  if (!reader.has(field)) {
    reader.issue(field, "missing", "Field required");
    return undefined;
  }
  const raw = source[field];
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    reader.issue(
      field,
      rules.integer ? "int_type" : "float_type",
      rules.integer ? "Input should be a valid integer" : "Input should be a valid number",
    );
    return undefined;
  }
  if (rules.integer && !Number.isInteger(raw)) {
    reader.issue(
      field,
      "int_from_float",
      "Input should be a valid integer, got a number with a fractional part",
    );
    return undefined;
  }
  if (rules.exclusiveMin !== undefined && raw <= rules.exclusiveMin) {
    reader.issue(field, "greater_than", `Input should be greater than ${rules.exclusiveMin}`);
    return undefined;
  }
  if (rules.min !== undefined && raw < rules.min) {
    reader.issue(
      field,
      "greater_than_equal",
      `Input should be greater than or equal to ${rules.min}`,
    );
    return undefined;
  }
  if (rules.max !== undefined && raw > rules.max) {
    reader.issue(field, "less_than_equal", `Input should be less than or equal to ${rules.max}`);
    return undefined;
  }
  return raw;
}

export function parseBudget(raw: unknown, base: Loc, details: ErrorDetail[]): Budget | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const source = asObject(raw);
  if (source === null) {
    details.push({
      loc: base,
      code: "model_attributes_type",
      message: "Input should be a valid dictionary or object to extract fields from",
    });
    return undefined;
  }
  const reader = new BodyReader(source, base);
  const maxUsd = readNumber(reader, source, "max_usd", { integer: false, min: 0 });
  const maxMinutes = readNumber(reader, source, "max_minutes", { integer: true, min: 1 });
  details.push(...reader.details);
  return maxUsd !== undefined && maxMinutes !== undefined
    ? { max_usd: maxUsd, max_minutes: maxMinutes }
    : undefined;
}

function parseSelection(
  raw: unknown,
  base: Loc,
  details: ErrorDetail[],
): PlanSelection | undefined {
  const source = asObject(raw);
  if (source === null) {
    details.push({
      loc: base,
      code: raw === undefined ? "missing" : "model_attributes_type",
      message:
        raw === undefined
          ? "Field required"
          : "Input should be a valid dictionary or object to extract fields from",
    });
    return undefined;
  }
  const reader = new BodyReader(source, base);
  const featureIds = reader.stringList("feature_ids", {}) ?? [];
  const areaIds = reader.stringList("area_ids", {}) ?? [];
  const roles = reader.stringList("roles", {}) ?? [];
  const interfaceMode = reader.enum("interface_mode", INTERFACE_MODES, { required: true });
  const depth = reader.enum("depth", DEPTHS, { required: true });
  const k = readNumber(reader, source, "k", { integer: true, min: 1, max: PLAN_MAX_K });
  const budget = parseBudget(source.budget, [...base, "budget"], reader.details);
  details.push(...reader.details);
  if (
    typeof interfaceMode !== "string" ||
    typeof depth !== "string" ||
    k === undefined ||
    reader.details.length > 0
  ) {
    return undefined;
  }
  const selection: PlanSelection = {
    feature_ids: featureIds,
    area_ids: areaIds,
    roles,
    interface_mode: interfaceMode,
    depth,
    k,
  };
  if (budget !== undefined) {
    selection.budget = budget;
  }
  return selection;
}

export function parsePlanSelection(raw: unknown, base: Loc): PlanSelection {
  const details: ErrorDetail[] = [];
  const selection = parseSelection(raw, base, details);
  throwIfAny(details);
  return selection as PlanSelection;
}

export function parsePlanCreate(raw: Source, base: Loc = ["body"]): ParsedPlanCreate {
  const reader = new BodyReader(raw, base);
  const targetId = reader.uuid("target_id", { required: true });
  const bundleId = reader.uuid("bundle_id", { required: false, nullable: true });
  const name = reader.string("name", {
    required: false,
    nullable: true,
    min: 1,
    max: PLAN_NAME_MAX,
    strip: true,
  });
  const saved = reader.boolean("saved", {});
  if (!reader.has("saved")) {
    reader.issue("saved", "missing", "Field required");
  }
  const includeApiFuzz = reader.boolean("include_api_fuzz", {});
  const details = [...reader.details];
  const selection = parseSelection(raw.selection, [...base, "selection"], details);
  throwIfAny(details);
  return {
    targetId: targetId as string,
    bundleId: bundleId ?? null,
    name: name ?? null,
    saved: saved === true,
    selection: selection as PlanSelection,
    includeApiFuzz: includeApiFuzz === true,
  };
}

export function notReady(details: ErrorDetail[], message: string): MockApiError {
  return new MockApiError(409, "target_not_ready", message, details);
}

export function resolveBundle(
  stageOne: StageOneStore,
  target: TargetRecord,
  bundleId: string | null,
): BundleRecord {
  if (bundleId !== null) {
    const explicit = stageOne.findBundle(bundleId);
    if (explicit === undefined || explicit.bundle.target_id !== target.id) {
      throw notFound("Bundle not found");
    }
    if (explicit.bundle.validation_status !== "valid") {
      throw validationFailed([
        {
          loc: ["body", "bundle_id"],
          code: "bundle_invalid",
          message: `Bundle v${explicit.bundle.version} did not validate`,
        },
      ]);
    }
    return explicit;
  }
  const latest = stageOne.latestValidBundle(target.id);
  if (latest === undefined) {
    throw notReady(
      [{ loc: ["bundle"], code: "bundle_missing", message: "The target has no valid bundle" }],
      "The target has no valid bundle yet; upload one first",
    );
  }
  return latest;
}

export function evaluatePlan(state: MockState, parsed: ParsedPlanCreate): Evaluation {
  const target = state.stageOne.findTarget(parsed.targetId);
  if (target === undefined) {
    throw notFound("Target not found");
  }
  const record = resolveBundle(state.stageOne, target, parsed.bundleId);
  const expansion = expandSelection(record, parsed.selection, {
    productionTier: target.tier === "production",
  });
  return {
    target,
    record,
    expansion,
    budget: parsed.selection.budget ?? { ...DEFAULT_RUN_BUDGET },
  };
}

export function toPreview(evaluation: Evaluation, options?: PreviewOptions): PlanPreview {
  const { expansion, budget, record } = evaluation;
  const warnings = [...expansion.warnings];
  if (expansion.cells.length === 0) {
    warnings.push("The selection expands to no cells; select at least one feature");
  }
  if (
    options?.includeApiFuzz === true &&
    !record.files.some((file) => file.path === OPENAPI_FILE)
  ) {
    warnings.push("API fuzz is skipped: the bundle has no openapi.json");
  }
  const runnable = runnableCellCount(expansion.cells);
  let estimatedCost: number | null = null;
  if (options !== undefined) {
    estimatedCost =
      options.depth === "smoke"
        ? 0
        : Math.round(runnable * ESTIMATE_COST_PER_CELL_USD * 100) / 100;
  }
  return {
    cells_total: expansion.cells.length,
    scenarios_estimated: runnable,
    skipped: expansion.skipped.map((entry) => ({ ...entry })),
    warnings,
    effective_budget: { ...budget },
    estimated_cost_usd: estimatedCost,
  };
}

export function planEmpty(): MockApiError {
  return new MockApiError(
    422,
    "plan_empty",
    "The selection expands to no cells; select at least one feature",
    [{ loc: ["body", "selection"], code: "plan_empty", message: "The selection is empty" }],
  );
}

export function cloneSelection(selection: PlanSelection): PlanSelection {
  const copy: PlanSelection = {
    feature_ids: [...(selection.feature_ids ?? [])],
    area_ids: [...(selection.area_ids ?? [])],
    roles: [...(selection.roles ?? [])],
    interface_mode: selection.interface_mode,
    depth: selection.depth,
    k: selection.k,
  };
  if (selection.budget !== undefined && selection.budget !== null) {
    copy.budget = { ...selection.budget };
  }
  return copy;
}

export function buildPlan(
  store: StageTwoStore,
  parsed: ParsedPlanCreate,
  evaluation: Evaluation,
  createdBy: string,
  createdAt: string,
  id?: string,
): Plan {
  const plan: PlanExtended = {
    id: id ?? stableId("plan_live", store.nextOrdinal("plan")),
    target_id: evaluation.target.id,
    bundle_id: evaluation.record.bundle.id,
    name: parsed.name,
    saved: parsed.saved,
    selection: cloneSelection(parsed.selection),
    effective_budget: { ...evaluation.budget },
    is_coverage_baseline: false,
    cells_total: evaluation.expansion.cells.length,
    schedule_id: null,
    created_by: createdBy,
    created_at: createdAt,
    include_api_fuzz: parsed.includeApiFuzz === true,
  };
  return plan;
}

export function planAsCreate(plan: Plan): ParsedPlanCreate {
  return {
    targetId: plan.target_id,
    bundleId: plan.bundle_id,
    name: plan.name,
    saved: plan.saved,
    selection: cloneSelection(plan.selection),
    includeApiFuzz: "include_api_fuzz" in plan && plan.include_api_fuzz === true,
  };
}

export function featureOf(record: BundleRecord, featureId: string | null): CatalogItem | null {
  if (featureId === null) {
    return null;
  }
  return record.features.find((feature) => feature.feature_id === featureId) ?? null;
}

export function ensureScenarios(
  store: StageTwoStore,
  target: TargetRecord,
  record: BundleRecord,
  cells: readonly ExpandedCell[],
  nowIso: string,
): ScenarioRecord[] {
  const entries: ScenarioRecord[] = [];
  cells.forEach((cell, index) => {
    const existing = store.scenarioByCell(target.id, cell.key);
    if (existing !== undefined) {
      entries.push(existing);
      return;
    }
    const feature = featureOf(record, cell.featureId);
    if (feature === null) {
      return;
    }
    const entry: ScenarioRecord = {
      scenario: buildSmokeScenario({
        targetId: target.id,
        record,
        feature,
        cell,
        createdAt: plusSeconds(nowIso, index),
      }),
      cellKey: cell.key,
    };
    store.addScenario(entry);
    entries.push(entry);
  });
  return entries;
}

export function failedInterfaceIds(target: TargetRecord): Set<string> {
  return new Set(
    (target.healthReport?.interfaces ?? [])
      .filter((entry) => entry.status === "failed")
      .map((entry) => entry.interface_id),
  );
}

export function missingRequiredVariables(
  stageOne: StageOneStore,
  targetId: string,
  cells: readonly ExpandedCell[],
): string[] {
  const used = new Set(
    cells.filter((cell) => !cell.productionBlocked).map((cell) => cell.interfaceId),
  );
  return stageOne
    .environmentOf(targetId)
    .filter(
      (entry) =>
        entry.required &&
        !entry.stale &&
        entry.value === null &&
        entry.interface_ids.some((id) => used.has(id)),
    )
    .map((entry) => entry.name);
}

export function baseUrlResolver(
  stageOne: StageOneStore,
  targetId: string,
): (interfaceId: string) => string {
  const entries = stageOne.environmentOf(targetId);
  return (interfaceId) => {
    const variable = entries.find(
      (entry) =>
        entry.kind === "url" &&
        !entry.stale &&
        entry.interface_ids.includes(interfaceId) &&
        entry.value !== null,
    );
    return (variable?.value ?? "http://app.test").replace(/\/+$/, "");
  };
}

export function buildConfigSnapshot(
  record: BundleRecord,
  createdAt: string,
  scenarioVersions: Record<string, number> = {},
): RunConfigSnapshot {
  return {
    bundle_id: record.bundle.id,
    bundle_version: record.bundle.version,
    bundle_hash: record.bundle.hash,
    seed_hash: null,
    clock: { mode: "real", at: createdAt },
    models: {},
    probe_bank_version: null,
    prompt_template_versions: {},
    scenario_versions: scenarioVersions,
  };
}
