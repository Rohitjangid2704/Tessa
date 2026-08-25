import { http } from "msw";
import { notFound } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { hashParts, requireIdempotencyKey, withIdempotency } from "../stage1/support";
import "../streams/redteam-script";
import { REDTEAM_FAMILIES } from "../stage7/redteam-data";
import { parseRedTeamCreate, startRedTeam } from "../stage7/redteam-service";
import { redteamStore, type AttackRecord } from "../stage7/redteam-store";
import type { AttackOutcome, RedTeamRound } from "@/lib/api/types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const ATTACK_OUTCOMES: readonly AttackOutcome[] = ["blocked", "breached", "inconclusive"];

const ROUND_PAGE: PageSpec<RedTeamRound> = {
  sortKeys: { index: { kind: "number", value: (row) => row.index } },
  defaultSort: "index",
  getId: (row) => row.id,
};

const ATTACK_PAGE: PageSpec<AttackRecord> = {
  sortKeys: {
    ordinal: { kind: "number", value: (row) => row.ordinal },
    family: { kind: "text", value: (row) => row.attack.family },
    outcome: { kind: "text", value: (row) => row.attack.outcome },
  },
  defaultSort: "ordinal",
  getId: (row) => row.attack.id,
};

function requireKnownRun(context: ApiContext, runId: string): void {
  const entry = context.state.stageTwo.findRun(runId);
  if (entry === undefined || entry.run.kind !== "redteam") {
    throw notFound("Red team run not found");
  }
}

async function listFamilies(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  return jsonResponse({ items: REDTEAM_FAMILIES });
}

async function createRedTeamRun(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  requireIdempotencyKey(context);
  const raw = await context.request.text();
  const request = parseRedTeamCreate(parseJsonObject(raw));
  return withIdempotency(
    context,
    user,
    { required: true, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => ({ status: 202, body: startRedTeam(context.state, user, request) }),
  );
}

async function listRounds(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  context.state.stageTwo.ensure();
  const query = new QueryReader(context.url.searchParams);
  const runId = query.uuid("run_id")?.toLowerCase();
  const paginate = readPage(query, ROUND_PAGE);
  query.finish();
  if (runId !== undefined) {
    requireKnownRun(context, runId);
  }
  const rounds = redteamStore.rounds.filter((round) => runId === undefined || round.run_id === runId);
  return jsonResponse(paginate(rounds.map((round) => ({ ...round }))));
}

async function listAttacks(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  context.state.stageTwo.ensure();
  const query = new QueryReader(context.url.searchParams);
  const runId = query.uuid("run_id")?.toLowerCase();
  const roundId = query.uuid("round_id")?.toLowerCase();
  const outcomes = query.enumList("outcome", ATTACK_OUTCOMES);
  const families = query.stringList("family");
  const paginate = readPage(query, ATTACK_PAGE);
  query.finish();
  if (runId !== undefined) {
    requireKnownRun(context, runId);
  }
  const rows = redteamStore.attacks.filter(
    (record) =>
      (runId === undefined || record.runId === runId) &&
      (roundId === undefined || record.attack.round_id === roundId) &&
      (outcomes === undefined || outcomes.includes(record.attack.outcome)) &&
      (families === undefined || families.includes(record.attack.family)),
  );
  const page = paginate(rows);
  return jsonResponse({ ...page, items: page.items.map((record) => ({ ...record.attack })) });
}

export const redteamHandlers = [
  http.get("*/api/v1/redteam/families", api(listFamilies)),
  http.post("*/api/v1/redteam-runs", api(createRedTeamRun)),
  http.get("*/api/v1/redteam-rounds", api(listRounds)),
  http.get("*/api/v1/attacks", api(listAttacks)),
];
