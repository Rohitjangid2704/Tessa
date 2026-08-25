import { http } from "msw";
import {
  toBundleSummary,
  type BundleDiff,
  type BundleSummary,
  type BundleUploadResult,
} from "../factories/bundles";
import { conflict, MockApiError, notFound, validationFailed } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { nowIso } from "../factories/targets";
import { parseJsonObject } from "../factories/validation";
import { BodyReader } from "../stage1/body";
import { diffBundles } from "../stage1/diff";
import { ingestBundle } from "../stage1/ingest";
import {
  extractToken,
  outcomeForName,
  outcomeForPaste,
  SECRET_DETAILS,
  type UploadOutcome,
} from "../stage1/outcomes";
import type { BundleRecord, TargetRecord } from "../stage1/store";
import {
  hashParts,
  pathUuid,
  requireIdempotencyKey,
  requireTarget,
  stageOne,
  withIdempotency,
} from "../stage1/support";
import { applyAuthoredImport, isAuthoredImportName } from "../stage6/authored-import";
import { applyMutantsImport, isMutantsImportName } from "../stage8/mutants-import";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const ACCEPTED_ZIP_TYPES = ["application/zip", "application/x-zip-compressed"];
const NOTE_MAX = 500;

const BUNDLE_PAGE: PageSpec<BundleSummary> = {
  sortKeys: { version: { kind: "number", value: (row) => row.version } },
  defaultSort: "-version",
  getId: (row) => row.id,
};

type Location = Array<string | number>;

function payloadTooLarge(code: string, message: string, loc: Location): MockApiError {
  return new MockApiError(413, "payload_too_large", message, [{ loc, code, message }]);
}

function archiveTooLarge(limit: number): MockApiError {
  return payloadTooLarge("archive_too_large", `The zip is larger than ${limit} bytes`, ["file"]);
}

function manifestTooLarge(limit: number): MockApiError {
  return payloadTooLarge("manifest_too_large", `The manifest is larger than ${limit} bytes`, [
    "body",
    "manifest_yaml",
  ]);
}

function unsupportedMediaType(contentType: string): MockApiError {
  const shown = contentType === "" ? "none" : contentType;
  const message = `The file must be a zip (application/zip), not ${shown}`;
  return new MockApiError(415, "unsupported_media_type", message, [
    { loc: ["form", "file"], code: "unsupported_media_type", message },
  ]);
}

const TOKEN_UNKNOWN_MESSAGE =
  "The target_token in manifest.yaml does not belong to any target; copy it from the Discovery prompt of the target";
const TOKEN_MISSING_MESSAGE =
  "manifest.yaml has no target_token and no target_id was given, so the bundle cannot be matched to a target";

function tokenUnknown(message: string = TOKEN_UNKNOWN_MESSAGE): MockApiError {
  return new MockApiError(422, "target_token_unknown", message, [
    { loc: ["manifest", "target_token"], code: "target_token_unknown", message },
  ]);
}

function tokenMismatch(): MockApiError {
  return new MockApiError(
    409,
    "target_token_mismatch",
    "The target_token in manifest.yaml belongs to a different target than target_id",
    [
      {
        loc: ["form", "target_id"],
        code: "target_token_mismatch",
        message: "target_id does not match the manifest target_token",
      },
    ],
  );
}

interface ResolvedTarget {
  target: TargetRecord;
  rotated: boolean;
}

function resolveTarget(
  context: ApiContext,
  explicitTargetId: string | null,
  embeddedToken: string | null,
): ResolvedTarget {
  if (embeddedToken === null) {
    if (explicitTargetId === null) {
      throw tokenUnknown(TOKEN_MISSING_MESSAGE);
    }
    return { target: requireTarget(context, explicitTargetId), rotated: false };
  }
  const matched = stageOne(context).findTargetByToken(embeddedToken);
  if (matched === null) {
    throw tokenUnknown();
  }
  if (explicitTargetId !== null && explicitTargetId !== matched.target.id) {
    throw tokenMismatch();
  }
  return { target: matched.target, rotated: matched.matchedPrevious };
}

function secretRejection(): MockApiError {
  const files = new Set(SECRET_DETAILS.map((detail) => detail.loc[1])).size;
  const placeholder = "${NAME}";
  return new MockApiError(
    422,
    "bundle_contains_secret",
    `The bundle contains ${SECRET_DETAILS.length} apparent secret(s) in ${files} file(s); nothing was stored. Replace each with a ${placeholder} placeholder and upload again`,
    SECRET_DETAILS,
  );
}

function rejectBeforeTarget(outcome: UploadOutcome, zipLimit: number): void {
  if (outcome.type === "too_large") {
    throw archiveTooLarge(zipLimit);
  }
  if (outcome.type === "secret") {
    throw secretRejection();
  }
}

function rejectAtTarget(outcome: UploadOutcome): void {
  if (outcome.type === "token_unknown") {
    throw tokenUnknown();
  }
  if (outcome.type === "token_mismatch") {
    throw tokenMismatch();
  }
}

function acceptOutcome(
  context: ApiContext,
  outcome: UploadOutcome,
  resolved: ResolvedTarget,
  source: "zip" | "manifest_paste",
  note: string | null,
  userId: string,
): { status: number; body: BundleUploadResult } {
  const { target, rotated } = resolved;
  if (target.archivedAt !== null) {
    throw conflict("conflict", "This target is archived");
  }
  const store = stageOne(context);
  if (outcome.type === "duplicate") {
    const latest = store.latestBundle(target.id);
    if (latest !== undefined) {
      return { status: 200, body: { bundle: latest.bundle, created: false, dry_run_run_id: null } };
    }
  }
  const { record, created } = ingestBundle({
    store,
    target,
    kind: outcome.type === "ingest" ? outcome.kind : "valid",
    source,
    note,
    uploadedBy: userId,
    origin: context.url.origin,
    now: nowIso(),
    rotatedToken: rotated,
  });
  return {
    status: created ? 201 : 200,
    body: { bundle: record.bundle, created, dry_run_run_id: null },
  };
}

async function readUploadForm(context: ApiContext): Promise<FormData> {
  try {
    return await context.request.formData();
  } catch {
    throw validationFailed([{ loc: ["body", "file"], code: "missing", message: "Field required" }]);
  }
}

async function uploadBundle(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  requireIdempotencyKey(context);
  const form = await readUploadForm(context);
  const file = form.get("file");
  const rawTarget = form.get("target_id");
  const rawNote = form.get("note");
  const details = new BodyReader({
    target_id: typeof rawTarget === "string" && rawTarget !== "" ? rawTarget : undefined,
    note: typeof rawNote === "string" ? rawNote : undefined,
  });
  const targetId = details.uuid("target_id", { required: false });
  const note = details.string("note", { required: false, max: NOTE_MAX });
  const problems = [...details.details];
  if (file === null || typeof file === "string") {
    problems.unshift({ loc: ["body", "file"], code: "missing", message: "Field required" });
  }
  if (problems.length > 0 || file === null || typeof file === "string") {
    throw validationFailed(problems);
  }
  const requestHash = hashParts(
    "POST",
    context.url.pathname,
    file.name,
    String(file.size),
    targetId ?? "",
    note ?? "",
  );
  return withIdempotency(context, user, { required: true, requestHash }, async () => {
    const mediaType = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ACCEPTED_ZIP_TYPES.includes(mediaType)) {
      throw unsupportedMediaType(file.type);
    }
    const zipLimit = stageOne(context).limits.bundle_max_zip_bytes;
    if (context.state.faults.upload413 || file.size > zipLimit) {
      throw archiveTooLarge(zipLimit);
    }
    const outcome = outcomeForName(file.name);
    rejectBeforeTarget(outcome, zipLimit);
    rejectAtTarget(outcome);
    const resolved = resolveTarget(context, targetId ?? null, extractToken(await file.text()));
    const accepted = acceptOutcome(context, outcome, resolved, "zip", note ?? null, user.id);
    const withScenarios = isAuthoredImportName(file.name)
      ? applyAuthoredImport(context.state, accepted, user.id)
      : accepted;
    return isMutantsImportName(file.name)
      ? applyMutantsImport(context.state, withScenarios)
      : withScenarios;
  });
}

async function pasteBundle(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  requireIdempotencyKey(context);
  const rawText = await context.request.text();
  const reader = new BodyReader(parseJsonObject(rawText));
  const targetId = reader.uuid("target_id", { required: false, nullable: true });
  const manifest = reader.string("manifest_yaml", { required: true, min: 1 });
  const note = reader.string("note", { required: false, max: NOTE_MAX, nullable: true });
  if (reader.details.length > 0 || typeof manifest !== "string") {
    throw validationFailed(reader.details);
  }
  return withIdempotency(
    context,
    user,
    { required: true, requestHash: hashParts("POST", context.url.pathname, rawText) },
    () => {
      const store = stageOne(context);
      const manifestLimit = store.limits.bundle_max_manifest_bytes;
      if (
        context.state.faults.upload413 ||
        new TextEncoder().encode(manifest).length > manifestLimit
      ) {
        throw manifestTooLarge(manifestLimit);
      }
      const outcome = outcomeForPaste(manifest);
      rejectBeforeTarget(outcome, store.limits.bundle_max_zip_bytes);
      rejectAtTarget(outcome);
      const resolved = resolveTarget(context, targetId ?? null, extractToken(manifest));
      return acceptOutcome(context, outcome, resolved, "manifest_paste", note ?? null, user.id);
    },
  );
}

async function listBundles(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const targetId = pathUuid(context, "target_id");
  const query = new QueryReader(context.url.searchParams);
  const paginate = readPage(query, BUNDLE_PAGE);
  query.finish();
  const target = requireTarget(context, targetId);
  const summaries = stageOne(context)
    .bundlesOf(target.id)
    .map((record) => toBundleSummary(record.bundle));
  return jsonResponse(paginate(summaries));
}

function requireBundle(context: ApiContext, bundleId: string): BundleRecord {
  const record = stageOne(context).findBundle(bundleId);
  if (record === undefined) {
    throw notFound("Bundle not found");
  }
  return record;
}

async function readBundle(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  return jsonResponse(requireBundle(context, pathUuid(context, "bundle_id")).bundle);
}

function resolveDiffBase(
  context: ApiContext,
  record: BundleRecord,
  against: string | undefined,
): BundleRecord | null {
  const store = stageOne(context);
  if (against === undefined) {
    return (
      store
        .bundlesOf(record.bundle.target_id)
        .filter(
          (candidate) =>
            candidate.bundle.version < record.bundle.version &&
            candidate.bundle.validation_status === "valid",
        )
        .at(-1) ?? null
    );
  }
  const explicit = store.findBundle(against);
  if (explicit === undefined) {
    throw notFound("The bundle to compare with does not exist");
  }
  if (explicit.bundle.target_id !== record.bundle.target_id) {
    throw new MockApiError(
      422,
      "validation_failed",
      "The bundles belong to different targets and cannot be compared",
      [
        {
          loc: ["query", "against"],
          code: "bundle_not_comparable",
          message: "against must be a version of the same target",
        },
      ],
    );
  }
  return explicit;
}

async function readDiff(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const record = requireBundle(context, pathUuid(context, "bundle_id"));
  const query = new QueryReader(context.url.searchParams);
  const against = query.uuid("against");
  query.finish();
  const compared = resolveDiffBase(context, record, against);
  if (record.bundle.validation_status !== "valid") {
    const empty: BundleDiff = {
      bundle_id: record.bundle.id,
      against_bundle_id: compared?.bundle.id ?? null,
      features: [],
      sections: [],
      summary: "The bundle is invalid, so there is no catalog to compare with.",
    };
    return jsonResponse(empty);
  }
  return jsonResponse(diffBundles(record, compared));
}

async function listFiles(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const record = requireBundle(context, pathUuid(context, "bundle_id"));
  return jsonResponse({
    items: record.files.map(({ path, size_bytes, sha256 }) => ({ path, size_bytes, sha256 })),
  });
}

async function readFile(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const record = requireBundle(context, pathUuid(context, "bundle_id"));
  const encoded = /\/files\/(.+)$/.exec(context.url.pathname)?.[1] ?? "";
  const path = decodeURIComponent(encoded);
  const file = record.files.find((candidate) => candidate.path === path);
  if (file === undefined) {
    throw notFound("The bundle has no such file");
  }
  return jsonResponse({ path: file.path, content: file.content, truncated: file.truncated });
}

export const bundleHandlers = [
  http.post("*/api/v1/bundles", api(uploadBundle)),
  http.post("*/api/v1/bundles/paste", api(pasteBundle)),
  http.get("*/api/v1/targets/:target_id/bundles", api(listBundles)),
  http.get("*/api/v1/bundles/:bundle_id", api(readBundle)),
  http.get("*/api/v1/bundles/:bundle_id/diff", api(readDiff)),
  http.get("*/api/v1/bundles/:bundle_id/files", api(listFiles)),
  http.get("*/api/v1/bundles/:bundle_id/files/*", api(readFile)),
];
