import { http } from "msw";
import { QueryReader } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { hashParts, requireIdempotencyKey, withIdempotency } from "../stage1/support";
import { CELL_STATUSES } from "../stage2/support";
import "../stage6/generate-script";
import {
  parseGenerateRequest,
  readCoverageMap,
  startGeneration,
} from "../stage6/coverage-service";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

async function readCoverage(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id", { required: true });
  const planId = query.uuid("plan_id");
  const bundleId = query.uuid("bundle_id");
  const areas = query.stringList("area");
  const statuses = query.enumList("status", CELL_STATUSES);
  query.finish();
  const map = readCoverageMap(context.state, {
    targetId: (targetId as string).toLowerCase(),
    planId: planId?.toLowerCase() ?? null,
    bundleId: bundleId?.toLowerCase() ?? null,
    areas,
    statuses,
  });
  return jsonResponse(map);
}

async function generateCoverage(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  requireIdempotencyKey(context);
  const raw = await context.request.text();
  const request = parseGenerateRequest(parseJsonObject(raw));
  return withIdempotency(
    context,
    user,
    { required: true, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => ({ status: 202, body: startGeneration(context.state, user, request) }),
  );
}

export const coverageHandlers = [
  http.get("*/api/v1/coverage", api(readCoverage)),
  http.post("*/api/v1/coverage/generate", api(generateCoverage)),
];
