import { http } from "msw";
import { notFound } from "../factories/errors";
import { QueryReader, readPage } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { hashParts, pathUuid, withIdempotency } from "../stage1/support";
import {
  nameTaken,
  parseBudgetSet,
  parseMembersSet,
  parseTeamCreate,
  parseTeamUpdate,
  TEAM_PAGE,
  toTeam,
  toTeamBudget,
} from "../stage10/teams-service";
import { teamsStore, type TeamRecord } from "../stage10/teams-store";
import { usersStore } from "../stage10/users-store";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

function requireTeam(context: ApiContext): TeamRecord {
  const team = teamsStore(context.state).find(pathUuid(context, "team_id"));
  if (team === undefined) {
    throw notFound("Team not found");
  }
  return team;
}

async function listTeams(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  const query = new QueryReader(context.url.searchParams);
  const paginate = readPage(query, TEAM_PAGE);
  query.finish();
  const rows = teamsStore(context.state).all.map((record) => toTeam(context.state, record));
  return jsonResponse(paginate(rows));
}

async function createTeam(context: ApiContext): Promise<Response> {
  const caller = await requireUser(context, "admin");
  const raw = await context.request.text();
  const { name } = parseTeamCreate(parseJsonObject(raw));
  return withIdempotency(
    context,
    caller,
    { required: false, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => {
      const store = teamsStore(context.state);
      if (store.findByName(name) !== undefined) {
        throw nameTaken();
      }
      return { status: 201, body: toTeam(context.state, store.create(name)) };
    },
  );
}

async function updateTeam(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  const team = requireTeam(context);
  const { name } = parseTeamUpdate(parseJsonObject(await context.request.text()));
  if (name !== null) {
    if (teamsStore(context.state).findByName(name, team.id) !== undefined) {
      throw nameTaken();
    }
    team.name = name;
  }
  return jsonResponse(toTeam(context.state, team));
}

async function setTeamMembers(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  const team = requireTeam(context);
  const raw = parseJsonObject(await context.request.text());
  const { userIds } = parseMembersSet(context.state, raw);
  usersStore.replaceTeamMembers(team.id, userIds);
  return jsonResponse(toTeam(context.state, team));
}

async function setTeamBudget(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  const team = requireTeam(context);
  const { maxUsdMonth } = parseBudgetSet(parseJsonObject(await context.request.text()));
  team.maxUsdMonth = maxUsdMonth;
  return jsonResponse(toTeamBudget(team, maxUsdMonth));
}

export const teamHandlers = [
  http.get("*/api/v1/teams", api(listTeams)),
  http.post("*/api/v1/teams", api(createTeam)),
  http.patch("*/api/v1/teams/:team_id", api(updateTeam)),
  http.put("*/api/v1/teams/:team_id/members", api(setTeamMembers)),
  http.put("*/api/v1/teams/:team_id/budget", api(setTeamBudget)),
];
