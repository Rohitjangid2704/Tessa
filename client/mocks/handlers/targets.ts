import { http } from "msw";
import { conflict, roleRequired, validationFailed } from "../factories/errors";
import { newId } from "../factories/ids";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { newTargetToken, nowIso, slugify, type TargetSummary } from "../factories/targets";
import { parseJsonObject } from "../factories/validation";
import { BodyReader } from "../stage1/body";
import type { StageOneStore, TargetRecord } from "../stage1/store";
import { applyTargetJevConsent, jevConsentStore } from "../stage10/jev-consent";
import { applyTargetTeam, assertCanSetTargetTeam } from "../stage10/teams-service";
import { pathUuid, requireActiveTarget, requireTarget, stageOne } from "../stage1/support";
import { toTarget, toTargetSummary } from "../stage1/views";
import type { MockUser } from "../types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

export const APP_KINDS = ["web", "api", "llm_assistant", "worker", "cli"] as const;
export const TARGET_TIERS = ["qa", "production"] as const;

const TARGET_NAME_MAX = 120;
const SEARCH_MAX = 200;
const SLUG_ATTEMPTS_LIMIT = 1000;

const TARGET_PAGE: PageSpec<TargetSummary> = {
  sortKeys: {
    name: { kind: "text", value: (row) => row.name },
    created_at: { kind: "timestamp", value: (row) => row.created_at },
  },
  defaultSort: "-created_at",
  getId: (row) => row.id,
};

function freeSlug(store: StageOneStore, base: string): string {
  const taken = new Set(store.targets.map((target) => target.slug));
  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; suffix < SLUG_ATTEMPTS_LIMIT; suffix += 1) {
    if (!taken.has(`${base}-${suffix}`)) {
      return `${base}-${suffix}`;
    }
  }
  throw conflict("conflict", "Could not allocate a unique slug for this name");
}

function requireAdminForProduction(user: MockUser, message: string): void {
  if (user.role !== "admin") {
    throw roleRequired("admin", message);
  }
}

async function listTargets(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const text = query.text("q", { max: SEARCH_MAX });
  const appKinds = query.enumList("app_kind", APP_KINDS);
  const tiers = query.enumList("tier", TARGET_TIERS);
  const includeArchived = query.boolean("include_archived", false);
  const paginate = readPage(query, TARGET_PAGE);
  query.finish();

  const needle = text?.toLowerCase();
  const store = stageOne(context);
  const summaries = store.targets
    .filter((target) => includeArchived || target.archivedAt === null)
    .filter(
      (target) =>
        needle === undefined ||
        target.name.toLowerCase().includes(needle) ||
        target.slug.includes(needle),
    )
    .filter((target) => appKinds === undefined || appKinds.includes(target.appKind))
    .filter((target) => tiers === undefined || tiers.includes(target.tier))
    .map((target) => toTargetSummary(store, target));
  return jsonResponse(paginate(summaries));
}

async function createTarget(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const body = new BodyReader(parseJsonObject(await context.request.text()));
  const name = body.string("name", { required: true, min: 1, max: TARGET_NAME_MAX, strip: true });
  const appKind = body.enum("app_kind", APP_KINDS, { required: true });
  const tier = body.enum("tier", TARGET_TIERS, { required: false, nullable: true });
  const hints = body.object("hints", { nullable: true });
  if (body.details.length > 0) {
    throw validationFailed(body.details);
  }
  const resolvedTier = tier ?? "qa";
  if (resolvedTier === "production") {
    requireAdminForProduction(user, "Only an admin can create a production target");
  }
  const store = stageOne(context);
  const record: TargetRecord = {
    id: newId(),
    name: name as string,
    slug: freeSlug(store, slugify(name as string)),
    appKind: appKind as TargetRecord["appKind"],
    tier: resolvedTier,
    allowProduction: false,
    targetToken: newTargetToken(),
    previousTargetToken: null,
    hints: hints ?? {},
    createdAt: nowIso(),
    createdBy: user.id,
    archivedAt: null,
    healthReport: null,
  };
  store.targets.push(record);
  return jsonResponse(toTarget(store, record), { status: 201 });
}

async function readTarget(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const target = requireTarget(context, pathUuid(context, "target_id"));
  return jsonResponse(toTarget(stageOne(context), target));
}

const UPDATE_NON_NULL_FIELDS = [
  "name",
  "app_kind",
  "tier",
  "allow_production",
  "allow_jev",
  "hints",
] as const;

async function updateTarget(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const targetId = pathUuid(context, "target_id");
  const raw = parseJsonObject(await context.request.text());
  const body = new BodyReader(raw);
  const name = body.string("name", {
    required: false,
    min: 1,
    max: TARGET_NAME_MAX,
    strip: true,
    nullable: true,
  });
  const appKind = body.enum("app_kind", APP_KINDS, { required: false, nullable: true });
  const tier = body.enum("tier", TARGET_TIERS, { required: false, nullable: true });
  const allowProduction = body.boolean("allow_production", { nullable: true });
  const allowJev = body.boolean("allow_jev", { nullable: true });
  const hints = body.object("hints", { nullable: true });
  const teamId = body.uuid("team_id", { required: false, nullable: true });
  if (body.details.length > 0) {
    throw validationFailed(body.details);
  }
  const target = requireActiveTarget(context, targetId);

  for (const field of UPDATE_NON_NULL_FIELDS) {
    if (raw[field] === null) {
      throw validationFailed([
        { loc: ["body", field], code: "null_not_allowed", message: "This field cannot be null" },
      ]);
    }
  }
  if (allowProduction !== undefined && allowProduction !== target.allowProduction) {
    requireAdminForProduction(user, "Only an admin can change allow_production");
  }
  if (allowJev !== undefined && allowJev !== jevConsentStore(context.state).isAllowed(targetId)) {
    requireAdminForProduction(user, "Only an admin can change allow_jev");
  }
  const tierChanges = tier !== undefined && tier !== null && tier !== target.tier;
  if (tierChanges && (tier === "production" || target.tier === "production")) {
    requireAdminForProduction(user, "Only an admin can change a production tier");
  }
  assertCanSetTargetTeam(context.state, user, targetId, teamId);

  if (typeof name === "string") {
    target.name = name;
  }
  if (appKind !== undefined && appKind !== null) {
    target.appKind = appKind;
  }
  if (tier !== undefined && tier !== null) {
    target.tier = tier;
  }
  if (typeof allowProduction === "boolean") {
    target.allowProduction = allowProduction;
  }
  if (hints !== undefined && hints !== null) {
    target.hints = hints;
  }
  applyTargetTeam(context.state, targetId, teamId);
  applyTargetJevConsent(context.state, targetId, allowJev);
  return jsonResponse(toTarget(stageOne(context), target));
}

async function archiveTarget(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  const target = requireTarget(context, pathUuid(context, "target_id"));
  target.archivedAt ??= nowIso();
  return new Response(null, { status: 204 });
}

async function rotateToken(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const target = requireActiveTarget(context, pathUuid(context, "target_id"));
  target.previousTargetToken = target.targetToken;
  target.targetToken = newTargetToken();
  return jsonResponse(toTarget(stageOne(context), target));
}

export const targetHandlers = [
  http.get("*/api/v1/targets", api(listTargets)),
  http.post("*/api/v1/targets", api(createTarget)),
  http.get("*/api/v1/targets/:target_id", api(readTarget)),
  http.patch("*/api/v1/targets/:target_id", api(updateTarget)),
  http.delete("*/api/v1/targets/:target_id", api(archiveTarget)),
  http.post("*/api/v1/targets/:target_id/token/rotate", api(rotateToken)),
];
