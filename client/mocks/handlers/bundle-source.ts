import { http } from "msw";
import { notFound } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import {
  hashParts,
  pathUuid,
  requireActiveTarget,
  requireIdempotencyKey,
  requireTarget,
  stageOne,
  withIdempotency,
} from "../stage1/support";
import { bundleSources } from "../stage9/bundle-source-store";
import {
  parseBundleSourceSet,
  parsePullBody,
  startBundleImport,
} from "../stage9/bundle-source-service";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const NO_SOURCE_MESSAGE = "No git source is configured for this target";

async function readBundleSource(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const target = requireTarget(context, pathUuid(context, "target_id"));
  const source = bundleSources.find(target.id);
  if (source === undefined) {
    throw notFound(NO_SOURCE_MESSAGE);
  }
  return jsonResponse(source);
}

async function putBundleSource(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const target = requireActiveTarget(context, pathUuid(context, "target_id"));
  const body = parseJsonObject(await context.request.text());
  const parsed = parseBundleSourceSet(body, stageOne(context).environmentOf(target.id));
  const existing = bundleSources.find(target.id);
  const saved = bundleSources.save(target.id, {
    ...parsed,
    last_pulled_at: existing?.last_pulled_at ?? null,
    last_ref: existing?.last_ref ?? null,
  });
  return jsonResponse(saved);
}

async function pullBundleSource(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  requireIdempotencyKey(context);
  const target = requireActiveTarget(context, pathUuid(context, "target_id"));
  const raw = await context.request.text();
  const ref = parsePullBody(parseJsonObject(raw));
  const source = bundleSources.find(target.id);
  if (source === undefined) {
    throw notFound(NO_SOURCE_MESSAGE);
  }
  return withIdempotency(
    context,
    user,
    { required: true, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => ({ status: 202, body: startBundleImport(context, user, target, source, ref) }),
  );
}

export const bundleSourceHandlers = [
  http.get("*/api/v1/targets/:target_id/bundle-source", api(readBundleSource)),
  http.put("*/api/v1/targets/:target_id/bundle-source", api(putBundleSource)),
  http.post("*/api/v1/targets/:target_id/bundle-source/pull", api(pullBundleSource)),
];
