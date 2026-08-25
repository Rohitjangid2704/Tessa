import { http } from "msw";
import { conflict, notFound, validationFailed } from "../factories/errors";
import { newId } from "../factories/ids";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { BodyReader } from "../stage1/body";
import {
  hashParts,
  pathUuid,
  requireActiveTarget,
  requireTarget,
  stageOne,
  withIdempotency,
} from "../stage1/support";
import { nowIso, stageTwo } from "../stage2/support";
import type { ScenarioRecord } from "../stage2/types";
import { toScenario } from "../stage2/views";
import { publishCoverageUpdated, publishScenarioChanged } from "../stage6/coverage-bus";
import { coverageStore } from "../stage6/coverage-store";
import { scenarioEdits } from "../stage6/scenario-edit-store";
import { checkScenarioYaml, type ScenarioCheck } from "../stage6/scenario-validation";
import type { Scenario, ScenarioStatus, ScenarioVersion } from "@/lib/api/types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

type JsonRecord = Record<string, unknown>;

const YAML_MAX_LENGTH = 200_000;
const NOTE_MAX_LENGTH = 2000;
const REVIEW_DECISIONS = ["accept", "reject"] as const;
const PATCH_STATUSES = ["retired", "quarantined", "accepted"] as const;
const FALLBACK_TITLE = "Untitled scenario";
const FALLBACK_FAMILY = "manual";

const VERSION_PAGE: PageSpec<ScenarioVersion> = {
  sortKeys: { version: { kind: "number", value: (row) => row.version } },
  defaultSort: "-version",
  getId: (row) => `${row.scenario_id}:${row.version}`,
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireScenario(context: ApiContext): ScenarioRecord {
  const entry = stageTwo(context).findScenario(pathUuid(context, "scenario_id"));
  if (entry === undefined) {
    throw notFound("Scenario not found");
  }
  return entry;
}

function unreadable(check: ScenarioCheck) {
  const first = check.validation.errors[0];
  return validationFailed([
    {
      loc: ["body", "yaml"],
      code: first?.code ?? "yaml_syntax",
      message: first?.message ?? "The YAML could not be read",
    },
  ]);
}

function documentFields(doc: JsonRecord) {
  return {
    title: typeof doc.title === "string" && doc.title.trim() !== "" ? doc.title : FALLBACK_TITLE,
    family: typeof doc.family === "string" && doc.family !== "" ? doc.family : FALLBACK_FAMILY,
    feature_id: typeof doc.feature_id === "string" ? doc.feature_id : null,
    synthetic: doc.synthetic === true,
  };
}

function announceChange(scenario: Scenario): void {
  publishScenarioChanged({
    targetId: scenario.target_id,
    scenarioId: scenario.id,
    cellId: scenario.cell_id,
    status: scenario.status,
  });
}

function settleCoverageCell(context: ApiContext, scenario: Scenario): void {
  if (scenario.cell_id === null) {
    return;
  }
  const located = coverageStore.findCell(scenario.cell_id);
  if (located === undefined) {
    return;
  }
  const { cell } = located;
  const siblings = stageTwo(context).scenarios.filter(
    (entry) => entry.scenario.cell_id === cell.id,
  );
  const waiting = siblings.some((entry) => entry.scenario.status === "in_review");
  const accepted = siblings.some((entry) => entry.scenario.status === "accepted");
  const settled = siblings.length >= cell.scenarioCount && !waiting;
  if (settled && (cell.status === "generated" || cell.status === "covered")) {
    cell.status = accepted ? "covered" : "empty";
  }
  publishCoverageUpdated({
    targetId: scenario.target_id,
    planId: null,
    cellIds: [cell.id],
    reason: "review",
  });
}

function statusAfterEdit(current: ScenarioStatus, valid: boolean): ScenarioStatus {
  if (!valid) {
    return "invalid";
  }
  return current === "invalid" ? "draft" : current;
}

async function createScenario(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const raw = await context.request.text();
  const reader = new BodyReader(parseJsonObject(raw));
  const targetId = reader.uuid("target_id", { required: true });
  const yaml = reader.string("yaml", { required: true, min: 1, max: YAML_MAX_LENGTH });
  if (reader.details.length > 0 || typeof targetId !== "string" || typeof yaml !== "string") {
    throw validationFailed(reader.details);
  }
  return withIdempotency(
    context,
    user,
    { required: false, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => {
      const target = requireActiveTarget(context, targetId);
      const record = stageOne(context).latestValidBundle(target.id);
      if (record === undefined) {
        throw conflict("conflict", "The target has no valid bundle yet");
      }
      const check = checkScenarioYaml(yaml, record);
      if (check.doc === null) {
        throw unreadable(check);
      }
      const now = nowIso();
      const fields = documentFields(check.doc);
      const scenario: Scenario = {
        id: newId(),
        target_id: target.id,
        bundle_id: record.bundle.id,
        cell_id: null,
        ...fields,
        origin: "manual",
        status: check.validation.valid ? "draft" : "invalid",
        version: 1,
        yaml,
        parsed: structuredClone(check.doc),
        validation: check.validation,
        provenance: { source: "manual", bundle_version: record.bundle.version, created_by: user.id },
        created_at: now,
        updated_at: now,
      };
      const entry: ScenarioRecord = { scenario, cellKey: null };
      stageTwo(context).addScenario(entry);
      scenarioEdits(context.state).startHistory(entry, user.id);
      announceChange(scenario);
      return { status: 201, body: toScenario(scenario) };
    },
  );
}

function readBaseVersion(reader: BodyReader, raw: JsonRecord): number | undefined {
  const base = raw.base_version;
  if (base === undefined) {
    reader.issue("base_version", "missing", "Field required");
    return undefined;
  }
  if (typeof base !== "number" || !Number.isInteger(base)) {
    reader.issue("base_version", "int_type", "Input should be a valid integer");
    return undefined;
  }
  if (base < 1) {
    reader.issue("base_version", "greater_than_equal", "Input should be greater than or equal to 1");
    return undefined;
  }
  return base;
}

async function updateScenario(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const entry = requireScenario(context);
  const raw = parseJsonObject(await context.request.text());
  const reader = new BodyReader(raw);
  const yaml = reader.string("yaml", { required: true, min: 1, max: YAML_MAX_LENGTH });
  const baseVersion = readBaseVersion(reader, raw);
  if (reader.details.length > 0 || typeof yaml !== "string" || baseVersion === undefined) {
    throw validationFailed(reader.details);
  }
  const { scenario } = entry;
  if (scenario.status === "retired") {
    throw conflict("conflict", "A retired scenario cannot be edited");
  }
  if (baseVersion !== scenario.version) {
    throw conflict(
      "version_conflict",
      `The scenario is at version ${scenario.version}, you edited version ${baseVersion}`,
    );
  }
  const record =
    stageOne(context).findBundle(scenario.bundle_id) ??
    stageOne(context).latestValidBundle(scenario.target_id);
  const check = checkScenarioYaml(yaml, record);
  if (check.doc === null) {
    throw unreadable(check);
  }
  const edits = scenarioEdits(context.state);
  edits.versionsOf(entry);
  const now = nowIso();
  Object.assign(scenario, documentFields(check.doc));
  scenario.yaml = yaml;
  scenario.parsed = structuredClone(check.doc);
  scenario.validation = check.validation;
  scenario.status = statusAfterEdit(scenario.status, check.validation.valid);
  scenario.version += 1;
  scenario.updated_at = now;
  edits.appendVersion(entry, user.id, now);
  announceChange(scenario);
  return jsonResponse(toScenario(scenario));
}

async function patchScenario(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const entry = requireScenario(context);
  const reader = new BodyReader(parseJsonObject(await context.request.text()));
  const status = reader.enum("status", PATCH_STATUSES, { required: true });
  if (reader.details.length > 0 || typeof status !== "string") {
    throw validationFailed(reader.details);
  }
  const { scenario } = entry;
  if (scenario.status === "retired") {
    throw conflict("conflict", "A retired scenario cannot change status");
  }
  if (status === "quarantined" && scenario.status !== "accepted") {
    throw conflict("conflict", "Only an accepted scenario can be quarantined");
  }
  if (status === "accepted" && scenario.status !== "quarantined") {
    throw conflict(
      "conflict",
      "Only a quarantined scenario can be accepted this way; scenarios in review use the review decision",
    );
  }
  scenario.status = status;
  scenario.updated_at = nowIso();
  announceChange(scenario);
  return jsonResponse(toScenario(scenario));
}

async function reviewScenario(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const entry = requireScenario(context);
  const reader = new BodyReader(parseJsonObject(await context.request.text()));
  const decision = reader.enum("decision", REVIEW_DECISIONS, { required: true });
  const note = reader.string("note", {
    required: false,
    nullable: true,
    max: NOTE_MAX_LENGTH,
    strip: true,
  });
  if (reader.details.length > 0 || typeof decision !== "string") {
    throw validationFailed(reader.details);
  }
  if (decision === "reject" && (note === undefined || note === null || note === "")) {
    throw validationFailed([
      { loc: ["body", "note"], code: "missing", message: "A note is required when rejecting" },
    ]);
  }
  const { scenario } = entry;
  if (scenario.status !== "in_review") {
    throw conflict("conflict", `The scenario is ${scenario.status}, not in review`);
  }
  const now = nowIso();
  scenario.status = decision === "accept" ? "accepted" : "rejected";
  scenario.updated_at = now;
  const review = {
    decision,
    note: decision === "reject" ? (note ?? null) : null,
    reviewed_by: user.id,
    reviewed_at: now,
  };
  scenarioEdits(context.state).recordReview(scenario.id, review);
  scenario.provenance = { ...(isRecord(scenario.provenance) ? scenario.provenance : {}), review };
  announceChange(scenario);
  settleCoverageCell(context, scenario);
  return jsonResponse(toScenario(scenario));
}

async function listVersions(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const entry = requireScenario(context);
  const query = new QueryReader(context.url.searchParams);
  const paginate = readPage(query, VERSION_PAGE);
  query.finish();
  const rows = scenarioEdits(context.state)
    .versionsOf(entry)
    .map((row) => structuredClone(row));
  return jsonResponse(paginate(rows));
}

async function readProvenance(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const entry = requireScenario(context);
  return jsonResponse(structuredClone(scenarioEdits(context.state).provenanceOf(entry)));
}

async function validateScenario(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const reader = new BodyReader(parseJsonObject(await context.request.text()));
  const targetId = reader.uuid("target_id", { required: true });
  const yaml = reader.string("yaml", { required: true, max: YAML_MAX_LENGTH });
  if (reader.details.length > 0 || typeof targetId !== "string" || typeof yaml !== "string") {
    throw validationFailed(reader.details);
  }
  const target = requireTarget(context, targetId);
  const record = stageOne(context).latestValidBundle(target.id);
  return jsonResponse(checkScenarioYaml(yaml, record).validation);
}

export const scenarioEditHandlers = [
  http.post("*/api/v1/scenarios/validate", api(validateScenario)),
  http.post("*/api/v1/scenarios", api(createScenario)),
  http.put("*/api/v1/scenarios/:scenario_id", api(updateScenario)),
  http.patch("*/api/v1/scenarios/:scenario_id", api(patchScenario)),
  http.get("*/api/v1/scenarios/:scenario_id/versions", api(listVersions)),
  http.get("*/api/v1/scenarios/:scenario_id/provenance", api(readProvenance)),
  http.post("*/api/v1/scenarios/:scenario_id/review", api(reviewScenario)),
];
