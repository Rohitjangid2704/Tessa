import { http } from "msw";
import { SERVICE_KEY_HEADER } from "../config";
import { notFound } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { ADMIN_USER } from "../factories/users";
import { parseJsonObject } from "../factories/validation";
import { hashParts, pathUuid, requireIdempotencyKey, withIdempotency } from "../stage1/support";
import { ensureContractSeed } from "../stage9/contracts-seed";
import {
  parseContractCheckCreate,
  startContractCheck,
  toContractCheck,
} from "../stage9/contracts-service";
import { contractStore } from "../stage9/contracts-store";
import type { MockUser } from "../types";
import type { ContractCheck } from "@/lib/api/types";
import { api, jsonResponse, requireServiceKey, requireUser, type ApiContext } from "./api";

const CHECK_PAGE: PageSpec<ContractCheck> = {
  sortKeys: { created_at: { kind: "timestamp", value: (row) => row.created_at } },
  defaultSort: "-created_at",
  getId: (row) => row.id,
};

async function memberOrService(context: ApiContext): Promise<MockUser> {
  if (context.request.headers.has(SERVICE_KEY_HEADER)) {
    requireServiceKey(context);
    return ADMIN_USER;
  }
  return requireUser(context, "member");
}

async function createContractCheck(context: ApiContext): Promise<Response> {
  const user = await memberOrService(context);
  requireIdempotencyKey(context);
  ensureContractSeed(context.state);
  const raw = await context.request.text();
  const parsed = parseContractCheckCreate(parseJsonObject(raw));
  return withIdempotency(
    context,
    user,
    { required: true, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => ({ status: 202, body: startContractCheck(context.state, user, parsed) }),
  );
}

async function listContractChecks(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  ensureContractSeed(context.state);
  const query = new QueryReader(context.url.searchParams);
  const consumerTargetId = query.uuid("consumer_target_id");
  const providerTargetId = query.uuid("provider_target_id");
  const paginate = readPage(query, CHECK_PAGE);
  query.finish();
  const rows = contractStore.entries
    .filter(
      (entry) =>
        (consumerTargetId === undefined || entry.consumerTargetId === consumerTargetId) &&
        (providerTargetId === undefined || entry.providerTargetId === providerTargetId),
    )
    .map((entry) => toContractCheck(context.state, entry));
  return jsonResponse(paginate(rows));
}

async function readContractCheck(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  ensureContractSeed(context.state);
  const entry = contractStore.find(pathUuid(context, "contract_check_id"));
  if (entry === undefined) {
    throw notFound("Contract check not found");
  }
  return jsonResponse(toContractCheck(context.state, entry));
}

export const contractHandlers = [
  http.post("*/api/v1/contract-checks", api(createContractCheck)),
  http.get("*/api/v1/contract-checks", api(listContractChecks)),
  http.get("*/api/v1/contract-checks/:contract_check_id", api(readContractCheck)),
];
