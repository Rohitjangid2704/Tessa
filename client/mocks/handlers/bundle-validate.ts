import { http } from "msw";
import { MockApiError, validationFailed } from "../factories/errors";
import { extractToken, outcomeForName, SECRET_DETAILS } from "../stage1/outcomes";
import { requireTarget, stageOne } from "../stage1/support";
import { buildValidationReport, hasProposalMarker } from "../stage11/validate-service";
import type { ContentKind } from "../stage1/bundle-content";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const ACCEPTED_ZIP_TYPES = ["application/zip", "application/x-zip-compressed"];

function unsupportedMediaType(contentType: string): MockApiError {
  const shown = contentType === "" ? "none" : contentType;
  const message = `The file must be a zip (application/zip), not ${shown}`;
  return new MockApiError(415, "unsupported_media_type", message, [
    { loc: ["form", "file"], code: "unsupported_media_type", message },
  ]);
}

function archiveTooLarge(limit: number): MockApiError {
  const message = `The zip is larger than ${limit} bytes`;
  return new MockApiError(413, "payload_too_large", message, [
    { loc: ["file"], code: "archive_too_large", message },
  ]);
}

function secretRejection(): MockApiError {
  const files = new Set(SECRET_DETAILS.map((detail) => detail.loc[1])).size;
  return new MockApiError(
    422,
    "bundle_contains_secret",
    `The bundle contains ${SECRET_DETAILS.length} apparent secret(s) in ${files} file(s); nothing was stored. Replace each with a \${NAME} placeholder and validate again`,
    SECRET_DETAILS,
  );
}

function unknownToken(): MockApiError {
  const message = "The target_token in manifest.yaml does not belong to any target";
  return new MockApiError(422, "target_token_unknown", message, [
    { loc: ["manifest", "target_token"], code: "target_token_unknown", message },
  ]);
}

async function readForm(context: ApiContext): Promise<FormData> {
  try {
    return await context.request.formData();
  } catch {
    throw validationFailed([{ loc: ["body", "file"], code: "missing", message: "Field required" }]);
  }
}

function contentKindOf(fileName: string, zipLimit: number): ContentKind {
  const outcome = outcomeForName(fileName);
  if (outcome.type === "too_large") {
    throw archiveTooLarge(zipLimit);
  }
  if (outcome.type === "secret") {
    throw secretRejection();
  }
  if (outcome.type === "token_unknown") {
    throw unknownToken();
  }
  return outcome.type === "ingest" ? outcome.kind : "valid";
}

async function validateBundle(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const form = await readForm(context);
  const file = form.get("file");
  const rawTarget = form.get("target_id");
  if (file === null || typeof file === "string") {
    throw validationFailed([{ loc: ["body", "file"], code: "missing", message: "Field required" }]);
  }
  const mediaType = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ACCEPTED_ZIP_TYPES.includes(mediaType)) {
    throw unsupportedMediaType(file.type);
  }
  const store = stageOne(context);
  const zipLimit = store.limits.bundle_max_zip_bytes;
  if (context.state.faults.upload413 || file.size > zipLimit) {
    throw archiveTooLarge(zipLimit);
  }
  const kind = contentKindOf(file.name, zipLimit);
  const embeddedToken = extractToken(await file.text());
  const embedded = embeddedToken === null ? null : store.findTargetByToken(embeddedToken);
  if (embeddedToken !== null && embedded === null) {
    throw unknownToken();
  }
  const explicit =
    typeof rawTarget === "string" && rawTarget !== "" ? requireTarget(context, rawTarget) : null;
  return jsonResponse(
    buildValidationReport({
      kind,
      target: explicit ?? embedded?.target ?? null,
      store,
      origin: context.url.origin,
      withProposal: hasProposalMarker(file.name),
    }),
  );
}

export const bundleValidateHandlers = [http.post("*/api/v1/bundles/validate", api(validateBundle))];
