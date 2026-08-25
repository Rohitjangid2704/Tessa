import type { Team, TeamBudget } from "@/lib/api/types";
import { MockApiError, roleRequired, validationFailed } from "../factories/errors";
import { isUuid } from "../factories/ids";
import type { PageSpec } from "../factories/pagination";
import { BodyReader } from "../stage1/body";
import type { MockState } from "../state";
import type { MockUser } from "../types";
import { teamsStore, type TeamRecord } from "./teams-store";
import { usersStore } from "./users-store";

export const TEAM_NAME_MAX = 80;
export const TEAM_BUDGET_MAX_USD = 1_000_000;
export const TEAM_MEMBERS_MAX = 5000;

const NAME_TAKEN_MESSAGE = "A team with this name already exists";

export const TEAM_PAGE: PageSpec<Team> = {
  sortKeys: {
    name: { kind: "text", value: (row) => row.name },
    member_count: { kind: "number", value: (row) => row.member_count },
    spent_month_usd: { kind: "number", value: (row) => row.spent_month_usd },
  },
  defaultSort: "name",
  getId: (row) => row.id,
};

export function toTeam(state: MockState, record: TeamRecord): Team {
  usersStore.ensure(state);
  return {
    id: record.id,
    name: record.name,
    member_count: usersStore.memberIdsOf(record.id).length,
    spent_month_usd: record.spentMonthUsd,
    max_usd_month: record.maxUsdMonth,
  };
}

export function currentBudgetMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function toTeamBudget(record: TeamRecord, maxUsdMonth: number): TeamBudget {
  return {
    team_id: record.id,
    month: currentBudgetMonth(),
    max_usd_month: maxUsdMonth,
    spent_month_usd: record.spentMonthUsd,
  };
}

export function nameTaken(): MockApiError {
  return new MockApiError(409, "conflict", NAME_TAKEN_MESSAGE, [
    { loc: ["body", "name"], code: "duplicate_name", message: NAME_TAKEN_MESSAGE },
  ]);
}

export function parseTeamCreate(raw: Record<string, unknown>): { name: string } {
  const body = new BodyReader(raw);
  const name = body.string("name", { required: true, min: 1, max: TEAM_NAME_MAX, strip: true });
  if (body.details.length > 0) {
    throw validationFailed(body.details);
  }
  return { name: String(name) };
}

export function parseTeamUpdate(raw: Record<string, unknown>): { name: string | null } {
  const body = new BodyReader(raw);
  const name = body.string("name", {
    required: false,
    nullable: true,
    min: 1,
    max: TEAM_NAME_MAX,
    strip: true,
  });
  if (body.details.length > 0) {
    throw validationFailed(body.details);
  }
  return { name: name ?? null };
}

export function parseMembersSet(
  state: MockState,
  raw: Record<string, unknown>,
): { userIds: string[] } {
  usersStore.ensure(state);
  const body = new BodyReader(raw);
  const userIds = body.stringList("user_ids", { maxItems: TEAM_MEMBERS_MAX });
  if (userIds === undefined) {
    body.issue("user_ids", "missing", "Field required");
  }
  if (body.details.length > 0 || userIds === undefined || userIds === null) {
    throw validationFailed(body.details);
  }
  const details = userIds.flatMap((userId, index) => {
    if (!isUuid(userId)) {
      return [
        {
          loc: ["body", "user_ids", index],
          code: "uuid_parsing",
          message: "Input should be a valid UUID",
        },
      ];
    }
    if (state.findUserById(userId.toLowerCase()) === undefined) {
      return [
        {
          loc: ["body", "user_ids", index],
          code: "user_not_found",
          message: "No user has this id",
        },
      ];
    }
    return [];
  });
  if (details.length > 0) {
    throw validationFailed(details);
  }
  return { userIds: [...new Set(userIds.map((userId) => userId.toLowerCase()))] };
}

export function parseBudgetSet(raw: Record<string, unknown>): { maxUsdMonth: number } {
  const loc = ["body", "max_usd_month"];
  const value = raw.max_usd_month;
  if (value === undefined) {
    throw validationFailed([{ loc, code: "missing", message: "Field required" }]);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw validationFailed([
      { loc, code: "float_type", message: "Input should be a valid number" },
    ]);
  }
  if (value <= 0) {
    throw validationFailed([
      { loc, code: "greater_than", message: "Input should be greater than 0" },
    ]);
  }
  if (value > TEAM_BUDGET_MAX_USD) {
    throw validationFailed([
      {
        loc,
        code: "less_than_equal",
        message: `Input should be less than or equal to ${TEAM_BUDGET_MAX_USD}`,
      },
    ]);
  }
  return { maxUsdMonth: value };
}

export function assertCanSetTargetTeam(
  state: MockState,
  user: MockUser,
  targetId: string,
  teamId: string | null | undefined,
): void {
  if (teamId === undefined) {
    return;
  }
  const store = teamsStore(state);
  if (teamId === store.teamIdOfTarget(targetId)) {
    return;
  }
  if (user.role !== "admin") {
    throw roleRequired("admin", "Only an admin can change the team of a target");
  }
  if (teamId !== null && store.find(teamId) === undefined) {
    throw validationFailed([
      { loc: ["body", "team_id"], code: "team_not_found", message: "No team has this id" },
    ]);
  }
}

export function applyTargetTeam(
  state: MockState,
  targetId: string,
  teamId: string | null | undefined,
): void {
  if (teamId !== undefined) {
    teamsStore(state).setTargetTeam(targetId, teamId);
  }
}
