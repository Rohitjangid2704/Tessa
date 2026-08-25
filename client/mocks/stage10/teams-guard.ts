import { teamBudgetExceeded } from "../factories/errors";
import type { MockState } from "../state";
import { teamsStore } from "./teams-store";

export function assertTeamBudget(state: MockState, targetId: string): void {
  const team = teamsStore(state).teamOfTarget(targetId);
  if (team === undefined || team.maxUsdMonth === null) {
    return;
  }
  if (team.spentMonthUsd >= team.maxUsdMonth) {
    throw teamBudgetExceeded(team.name);
  }
}
