import { http } from "msw";
import type { AuditVia, PersonalToken, PersonalTokenCreated } from "@/lib/api/types";
import { notFound } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { pathUuid } from "../stage1/support";
import { personalTokenOf } from "../stage11/bearer-writes";
import {
  assertBelowTokenLimit,
  parseTokenCreate,
  recordTokenCreated,
  recordTokenRevoked,
} from "../stage11/tokens-service";
import { tokensStore } from "../stage11/tokens-store";
import type { MockUser } from "../types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

function viaOf(context: ApiContext): AuditVia {
  return personalTokenOf(context.request) === null ? "web" : "mcp";
}

function listResponse(userId: string): Response {
  const items: PersonalToken[] = tokensStore.listOf(userId);
  return jsonResponse({ items });
}

async function listOwn(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "viewer");
  return listResponse(user.id);
}

async function createOwn(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "viewer");
  const input = parseTokenCreate(parseJsonObject(await context.request.text()));
  assertBelowTokenLimit(user.id);
  const record = tokensStore.mint(user.id, input.name, input.expiresInDays);
  recordTokenCreated(user.id, record.token.id, viaOf(context), record.token.name);
  const body: PersonalTokenCreated = { token: record.secret, item: { ...record.token } };
  return jsonResponse(body, { status: 201 });
}

function revokeFor(context: ApiContext, ownerId: string, actor: MockUser): Response {
  const record = tokensStore.find(ownerId, pathUuid(context, "token_id"));
  if (record === undefined) {
    throw notFound("Token not found");
  }
  if (tokensStore.revoke(record)) {
    recordTokenRevoked(actor.id, record.token.id, viaOf(context), record.token.name);
  }
  return new Response(null, { status: 204 });
}

async function revokeOwn(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "viewer");
  return revokeFor(context, user.id, user);
}

async function listForUser(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  return listResponse(pathUuid(context, "user_id"));
}

async function revokeForUser(context: ApiContext): Promise<Response> {
  const admin = await requireUser(context, "admin");
  return revokeFor(context, pathUuid(context, "user_id"), admin);
}

export const personalTokenHandlers = [
  http.get("*/api/v1/users/me/tokens", api(listOwn)),
  http.post("*/api/v1/users/me/tokens", api(createOwn)),
  http.delete("*/api/v1/users/me/tokens/:token_id", api(revokeOwn)),
  http.get("*/api/v1/users/:user_id/tokens", api(listForUser)),
  http.delete("*/api/v1/users/:user_id/tokens/:token_id", api(revokeForUser)),
];
