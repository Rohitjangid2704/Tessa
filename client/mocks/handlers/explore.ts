import { http } from "msw";
import { parseJsonObject } from "../factories/validation";
import { hashParts, pathUuid, requireIdempotencyKey, withIdempotency } from "../stage1/support";
import { parseExplorationCreate, requestStop, startExploration } from "../stage7/explore-service";
import { requireRunEntry } from "../stage2/support";
import { toRun } from "../stage2/views";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

async function createExploration(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  requireIdempotencyKey(context);
  const raw = await context.request.text();
  const parsed = parseExplorationCreate(parseJsonObject(raw));
  return withIdempotency(
    context,
    user,
    { required: true, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => ({ status: 202, body: startExploration(context, user, parsed) }),
  );
}

async function stopRun(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const entry = requireRunEntry(context, pathUuid(context, "run_id"));
  requestStop(context, user, entry);
  return jsonResponse(toRun(entry), { status: 202 });
}

export const exploreHandlers = [
  http.post("*/api/v1/explorations", api(createExploration)),
  http.post("*/api/v1/runs/:run_id/stop", api(stopRun)),
];
