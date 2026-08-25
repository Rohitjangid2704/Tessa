import { http } from "msw";
import { QueryReader } from "../factories/pagination";
import { INVARIANT_CATALOG, INVARIANT_PACK_ORDER } from "../stage5/invariant-catalog";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

async function listInvariants(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const packs = query.enumList("pack", INVARIANT_PACK_ORDER);
  query.finish();
  const items = INVARIANT_CATALOG.filter(
    (entry) => packs === undefined || packs.includes(entry.pack),
  ).map((entry) => ({ ...entry }));
  return jsonResponse({ items });
}

export const invariantHandlers = [http.get("*/api/v1/invariants", api(listInvariants))];
