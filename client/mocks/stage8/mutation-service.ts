import { conflict, dependencyUnavailable, MockApiError, validationFailed } from "../factories/errors";
import { newId } from "../factories/ids";
import type { ApiContext } from "../handlers/api";
import { launchRun } from "../server/run-simulator";
import { assertTeamBudget } from "../stage10/teams-guard";
import { BodyReader, type Source } from "../stage1/body";
import { requireActiveTarget } from "../stage1/support";
import { stableId } from "../stage2/ids";
import { buildConfigSnapshot } from "../stage2/plan-service";
import { nowIso } from "../stage2/support";
import { invariantInfo } from "../stage5/invariant-catalog";
import { productionBlockedError } from "../stage7/explore-service";
import type { ErrorDetail, MockUser } from "../types";
import { planOutcomes } from "./mutation-plan";
import { mutationStore, type StoredMutationRun } from "./mutation-store";
import "../streams/mutation-script";
import type { Mutant, MutantStatus, RunHandle } from "@/lib/api/types";

export const MUTANT_STATUSES = ["registered", "deployed", "retired"] as const satisfies readonly MutantStatus[];

export const MUTANT_NAME_MAX = 120;
export const MUTANT_BRANCH_MAX = 200;
export const MUTANT_DESCRIPTION_MAX = 2000;
export const MUTANT_BASE_URL_MAX = 500;
export const MUTANT_MAX_CATCHERS = 20;

const HTTP_URL_PATTERN = /^https?:\/\/\S+$/;
const PRODUCTION_HOST_PATTERN = /(^|[.-])(prod|production|live)([.-]|$)/i;
const URL_MESSAGE = "Input should be a valid URL, relative URL without a base";

export interface ParsedMutantCreate {
  targetId: string;
  name: string;
  branch: string;
  description: string;
  expectedCatchers: string[];
  baseUrl: string | null;
}

export interface MutantChanges {
  name?: string;
  branch?: string;
  description?: string;
  expectedCatchers?: string[];
  baseUrl?: string | null;
  status?: MutantStatus;
}

export interface ParsedMutationRun {
  targetId: string;
  mutantId: string;
  planId: string;
  baseUrlOverride: string | null;
}

function readBaseUrl(reader: BodyReader, field: string): string | null | undefined {
  const raw = reader.string(field, { required: false, nullable: true, max: MUTANT_BASE_URL_MAX, strip: true });
  if (raw === undefined || raw === null) {
    return raw;
  }
  if (raw === "") {
    return null;
  }
  if (!HTTP_URL_PATTERN.test(raw)) {
    reader.issue(field, "url_parsing", URL_MESSAGE);
    return undefined;
  }
  return raw;
}

function readCatchers(reader: BodyReader, required: boolean): string[] | undefined {
  const listed = reader.stringList("expected_catchers", { nullable: !required, maxItems: MUTANT_MAX_CATCHERS });
  if (listed === undefined) {
    if (required && !reader.has("expected_catchers")) {
      reader.issue("expected_catchers", "missing", "Field required");
    }
    return undefined;
  }
  if (listed === null) {
    return undefined;
  }
  if (listed.length === 0) {
    reader.issue(
      "expected_catchers",
      "too_short",
      "List should have at least 1 item after validation, not 0",
    );
    return undefined;
  }
  const unique = [...new Set(listed)];
  unique.forEach((id, index) => {
    if (invariantInfo(id) === undefined) {
      reader.details.push({
        loc: ["body", "expected_catchers", index],
        code: "unknown_invariant",
        message: `Unknown invariant '${id}'`,
      });
    }
  });
  return unique;
}

export function parseMutantCreate(body: Source): ParsedMutantCreate {
  const reader = new BodyReader(body);
  const targetId = reader.uuid("target_id", { required: true });
  const name = reader.string("name", { required: true, min: 1, max: MUTANT_NAME_MAX, strip: true });
  const branch = reader.string("branch", { required: true, min: 1, max: MUTANT_BRANCH_MAX, strip: true });
  const description = reader.string("description", {
    required: true,
    min: 1,
    max: MUTANT_DESCRIPTION_MAX,
    strip: true,
  });
  const catchers = readCatchers(reader, true);
  const baseUrl = readBaseUrl(reader, "base_url");
  if (
    reader.details.length > 0 ||
    targetId == null ||
    name == null ||
    branch == null ||
    description == null ||
    catchers === undefined
  ) {
    throw validationFailed(reader.details);
  }
  return {
    targetId,
    name,
    branch,
    description,
    expectedCatchers: catchers,
    baseUrl: baseUrl ?? null,
  };
}

export function parseMutantUpdate(body: Source): MutantChanges {
  const reader = new BodyReader(body);
  const name = reader.string("name", { required: false, nullable: true, min: 1, max: MUTANT_NAME_MAX, strip: true });
  const branch = reader.string("branch", {
    required: false,
    nullable: true,
    min: 1,
    max: MUTANT_BRANCH_MAX,
    strip: true,
  });
  const description = reader.string("description", {
    required: false,
    nullable: true,
    min: 1,
    max: MUTANT_DESCRIPTION_MAX,
    strip: true,
  });
  const status = reader.enum("status", MUTANT_STATUSES, { required: false, nullable: true });
  const catchers = readCatchers(reader, false);
  const baseUrl = readBaseUrl(reader, "base_url");
  if (reader.details.length > 0) {
    throw validationFailed(reader.details);
  }
  const changes: MutantChanges = {};
  if (name !== undefined && name !== null) {
    changes.name = name;
  }
  if (branch !== undefined && branch !== null) {
    changes.branch = branch;
  }
  if (description !== undefined && description !== null) {
    changes.description = description;
  }
  if (status !== undefined && status !== null) {
    changes.status = status;
  }
  if (catchers !== undefined) {
    changes.expectedCatchers = catchers;
  }
  if (baseUrl !== undefined) {
    changes.baseUrl = baseUrl;
  }
  return changes;
}

export function parseMutationRunCreate(body: Source): ParsedMutationRun {
  const reader = new BodyReader(body);
  const targetId = reader.uuid("target_id", { required: true });
  const mutantId = reader.uuid("mutant_id", { required: true });
  const planId = reader.uuid("plan_id", { required: true });
  const override = readBaseUrl(reader, "base_url_override");
  if (reader.details.length > 0 || targetId == null || mutantId == null || planId == null) {
    throw validationFailed(reader.details);
  }
  return { targetId, mutantId, planId, baseUrlOverride: override ?? null };
}

export function createMutant(parsed: ParsedMutantCreate): Mutant {
  const duplicate = mutationStore
    .mutantsOf(parsed.targetId)
    .some((mutant) => mutant.name.toLowerCase() === parsed.name.toLowerCase());
  if (duplicate) {
    throw conflict("conflict", `A mutant named ${parsed.name} is already registered for this target`);
  }
  return mutationStore.addMutant({
    id: newId(),
    target_id: parsed.targetId,
    name: parsed.name,
    branch: parsed.branch,
    description: parsed.description,
    expected_catchers: parsed.expectedCatchers,
    base_url: parsed.baseUrl,
    status: "registered",
    last_outcome: null,
    created_at: nowIso(),
  });
}

export function applyMutantChanges(mutant: Mutant, changes: MutantChanges): Mutant {
  const next: Mutant = {
    ...mutant,
    name: changes.name ?? mutant.name,
    branch: changes.branch ?? mutant.branch,
    description: changes.description ?? mutant.description,
    expected_catchers: changes.expectedCatchers ?? mutant.expected_catchers,
    base_url: changes.baseUrl === undefined ? mutant.base_url : changes.baseUrl,
    status: changes.status ?? mutant.status,
  };
  const details: ErrorDetail[] = [];
  if (next.status === "deployed" && next.base_url === null) {
    details.push({
      loc: ["body", "base_url"],
      code: "value_error",
      message: "Value error, a deployed mutant needs a base_url",
    });
  }
  if (details.length > 0) {
    throw validationFailed(details);
  }
  const renamed = changes.name !== undefined && changes.name.toLowerCase() !== mutant.name.toLowerCase();
  const duplicate = mutationStore
    .mutantsOf(mutant.target_id)
    .some((other) => other.id !== mutant.id && other.name.toLowerCase() === next.name.toLowerCase());
  if (renamed && duplicate) {
    throw conflict("conflict", `A mutant named ${next.name} is already registered for this target`);
  }
  mutationStore.addMutant(next);
  return next;
}

export function hasActiveRun(mutantId: string): boolean {
  return mutationStore.runsOfMutant(mutantId).some((run) => mutationStore.isActive(run));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function isProductionUrl(url: string): boolean {
  return PRODUCTION_HOST_PATTERN.test(hostOf(url));
}

function productionOverrideError(): MockApiError {
  return new MockApiError(
    409,
    "production_blocked",
    "The base URL override points at a production system",
    [
      {
        loc: ["body", "base_url_override"],
        code: "production_blocked",
        message: "A mutation run never runs against a production URL",
      },
    ],
  );
}

function unknownIdError(field: string, message: string): MockApiError {
  return validationFailed([{ loc: ["body", field], code: "value_error", message: `Value error, ${message}` }]);
}

export function startMutationRun(
  context: ApiContext,
  user: MockUser,
  parsed: ParsedMutationRun,
): RunHandle {
  const { state } = context;
  const store = state.stageTwo;
  const target = requireActiveTarget(context, parsed.targetId);
  if (state.faults.isDependencyDown("temporal")) {
    throw dependencyUnavailable("temporal", "Temporal is not running");
  }
  if (state.faults.productionBlocked || target.tier === "production") {
    throw productionBlockedError(target.name);
  }
  if (parsed.baseUrlOverride !== null && isProductionUrl(parsed.baseUrlOverride)) {
    throw productionOverrideError();
  }
  assertTeamBudget(state, target.id);
  const mutant = mutationStore.findMutant(parsed.mutantId);
  if (mutant === undefined || mutant.target_id !== target.id) {
    throw unknownIdError("mutant_id", "mutant not found for this target");
  }
  const plan = store.findPlan(parsed.planId);
  if (plan === undefined || plan.target_id !== target.id) {
    throw unknownIdError("plan_id", "plan not found for this target");
  }
  if (mutant.status !== "deployed") {
    throw conflict(
      "conflict",
      mutant.status === "retired"
        ? `The mutant ${mutant.name} is retired`
        : `The mutant ${mutant.name} is registered but not deployed. Deploy its branch to QA and mark it deployed first`,
    );
  }
  if (hasActiveRun(mutant.id)) {
    throw conflict("conflict", `A mutation run for ${mutant.name} is already in progress`);
  }
  const record = state.stageOne.latestValidBundle(target.id);
  if (record === undefined) {
    throw new MockApiError(409, "target_not_ready", "The target has no valid bundle", [
      { loc: ["bundle"], code: "bundle_missing", message: "Upload a valid bundle first" },
    ]);
  }
  const behaviour = mutationStore.nextRun;
  mutationStore.nextRun = "default";
  const baseUrl = parsed.baseUrlOverride ?? mutant.base_url ?? "";
  const runId = stableId("run_live", store.nextOrdinal("run"));
  const stored: StoredMutationRun = mutationStore.addRun({
    id: stableId("mutation_run", runId),
    runId,
    mutantId: mutant.id,
    planId: plan.id,
    outcomes: [],
    power: null,
    startedAt: nowIso(),
    finishedAt: null,
  });
  const entry = launchRun(state, store, {
    kind: "mutation",
    createdBy: user.id,
    targetId: target.id,
    planId: plan.id,
    bundleId: record.bundle.id,
    readOnly: false,
    budget: { ...plan.effective_budget },
    configSnapshot: buildConfigSnapshot(record, stored.startedAt),
    params: {
      mutation_run_id: stored.id,
      mutant_id: mutant.id,
      planned: behaviour === "failed" ? [] : planOutcomes(store, mutant, behaviour),
      fail_reason:
        behaviour === "failed" ? `The mutant at ${baseUrl} did not answer its health check` : null,
    },
    id: runId,
  });
  return {
    run_id: entry.run.id,
    workflow_id: entry.run.workflow_id,
    kind: entry.run.kind,
    status: entry.run.status,
    created_at: entry.run.created_at,
  };
}
