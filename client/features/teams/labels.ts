import { describeApiError, isApiError } from "@/lib/api/errors";
import type { Team } from "@/lib/api/types";
import { formatUsd } from "@/lib/format-usd";

export type SpendState = "none" | "within" | "reached" | "over";

export const SPEND_STATE_LABELS = {
  none: "No budget set",
  within: "Within budget",
  reached: "Budget reached",
  over: "Over budget",
} as const satisfies Record<SpendState, string>;

export const SPEND_STATE_HINTS = {
  none: "No monthly budget limits runs for this team's targets.",
  within: "Runs for this team's targets can start.",
  reached: "New runs for this team's targets are refused until the budget is raised.",
  over: "New runs for this team's targets are refused until the budget is raised.",
} as const satisfies Record<SpendState, string>;

type SpendFigures = Pick<Team, "spent_month_usd" | "max_usd_month">;

export function spendStateOf(team: SpendFigures): SpendState {
  if (team.max_usd_month === null) {
    return "none";
  }
  if (team.spent_month_usd > team.max_usd_month) {
    return "over";
  }
  return team.spent_month_usd === team.max_usd_month ? "reached" : "within";
}

export function spendFractionOf(team: SpendFigures): number | null {
  if (team.max_usd_month === null || team.max_usd_month <= 0) {
    return null;
  }
  return team.spent_month_usd / team.max_usd_month;
}

export function describeSpend(team: SpendFigures): string {
  if (team.max_usd_month === null) {
    return `${formatUsd(team.spent_month_usd)} spent this month`;
  }
  return `${formatUsd(team.spent_month_usd)} of ${formatUsd(team.max_usd_month)} this month`;
}

export function describeMemberCount(count: number): string {
  return count === 1 ? "1 member" : `${count} members`;
}

export type TeamAction = "create" | "rename" | "members" | "budget" | "target";

const ACTION_VERBS = {
  create: "create the team",
  rename: "rename the team",
  members: "save the members",
  budget: "save the budget",
  target: "change the team of this target",
} as const satisfies Record<TeamAction, string>;

export function describeTeamFailure(action: TeamAction, error: unknown): string {
  const verb = ACTION_VERBS[action];
  if (isApiError(error)) {
    if (error.status === 403) {
      return `Only admins can ${verb}.`;
    }
    if (error.status === 404) {
      return `Could not ${verb}: the team no longer exists. Reload the list.`;
    }
    if (error.status === 409 && action === "target") {
      return "This target is archived, so its team cannot change.";
    }
    if (error.status === 409) {
      return "A team with this name already exists. Choose another name.";
    }
  }
  return `Could not ${verb}. ${describeApiError(error)}`;
}
