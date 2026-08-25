import { http } from "msw";
import { notFound } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { hashParts, pathUuid, requireIdempotencyKey, withIdempotency } from "../stage1/support";
import { parseRunGroupCreate, startRunGroup } from "../stage9/run-group-service";
import { runGroupStore } from "../stage9/run-group-store";
import { toRunGroup } from "../stage9/run-group-views";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

async function createRunGroup(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  requireIdempotencyKey(context);
  const raw = await context.request.text();
  const parsed = parseRunGroupCreate(parseJsonObject(raw));
  return withIdempotency(
    context,
    user,
    { required: true, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => ({ status: 202, body: startRunGroup(context.state, user, parsed) }),
  );
}

async function readRunGroup(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const runGroupId = pathUuid(context, "run_group_id");
  const store = context.state.stageTwo;
  store.ensure();
  const record = runGroupStore(store).find(runGroupId);
  if (record === undefined) {
    throw notFound("Run group not found");
  }
  return jsonResponse(toRunGroup(store, record));
}

export const runGroupHandlers = [
  http.post("*/api/v1/run-groups", api(createRunGroup)),
  http.get("*/api/v1/run-groups/:run_group_id", api(readRunGroup)),
];
