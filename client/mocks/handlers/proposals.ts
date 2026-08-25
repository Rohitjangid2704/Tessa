import { http } from "msw";
import type { AuditVia } from "@/lib/api/types";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { BodyReader } from "../stage1/body";
import {
  hashParts,
  pathUuid,
  requireActiveTarget,
  requireTarget,
  withIdempotency,
} from "../stage1/support";
import { personalTokenOf } from "../stage11/bearer-writes";
import { PROPOSAL_YAML_MAX_BYTES } from "../stage11/proposals-data";
import {
  parseItemUpdate,
  parsePlanRequest,
  planFromProposal,
  putProposal,
  readProposal,
  updateItem,
} from "../stage11/proposals-service";
import "../stage11/seed-modules";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

function viaOf(context: ApiContext): AuditVia {
  return personalTokenOf(context.request) === null ? "web" : "mcp";
}

async function getProposal(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const target = requireTarget(context, pathUuid(context, "target_id"));
  return jsonResponse(readProposal(context.state, target));
}

async function putTargetProposal(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const target = requireActiveTarget(context, pathUuid(context, "target_id"));
  const reader = new BodyReader(parseJsonObject(await context.request.text()));
  const yaml = reader.string("yaml", { required: true, min: 1, max: PROPOSAL_YAML_MAX_BYTES });
  if (reader.details.length > 0 || typeof yaml !== "string") {
    throw validationFailed(reader.details);
  }
  return jsonResponse(putProposal(context.state, user, viaOf(context), target, yaml));
}

async function patchItem(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const itemId = pathUuid(context, "item_id");
  const update = parseItemUpdate(parseJsonObject(await context.request.text()));
  return jsonResponse(updateItem(context.state, user, viaOf(context), itemId, update));
}

async function planProposal(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const target = requireActiveTarget(context, pathUuid(context, "target_id"));
  const raw = await context.request.text();
  const request = parsePlanRequest(parseJsonObject(raw === "" ? "{}" : raw));
  return withIdempotency(
    context,
    user,
    { required: false, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => ({ status: 201, body: planFromProposal(context.state, user, target, request) }),
  );
}

export const proposalHandlers = [
  http.get("*/api/v1/targets/:target_id/proposal", api(getProposal)),
  http.put("*/api/v1/targets/:target_id/proposal", api(putTargetProposal)),
  http.patch("*/api/v1/proposal-items/:item_id", api(patchItem)),
  http.post("*/api/v1/targets/:target_id/proposal/plan", api(planProposal)),
];
