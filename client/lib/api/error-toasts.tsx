import Link from "next/link";
import { toast } from "sonner";
import { settingsRoutes } from "@/lib/routes";
import type { ApiError } from "./errors";

export const ROLE_REQUIRED_TOAST_ID = "api-error-role-required";
export const TEAM_BUDGET_TOAST_ID = "api-error-team-budget-exceeded";

export function describeRoleRequired(error: ApiError): string {
  const role = error.requiredRole;
  return role === null
    ? "This action needs a higher role than yours."
    : `This action needs the ${role} role.`;
}

export function toastRoleRequired(error: ApiError): void {
  const requestSuffix = error.requestId ? ` (request ${error.requestId})` : "";
  toast.error("Not allowed with your role", {
    id: ROLE_REQUIRED_TOAST_ID,
    description: `${describeRoleRequired(error)} Your role was checked again.${requestSuffix}`,
  });
}

export function toastTeamBudgetExceeded(error: ApiError): void {
  const team = error.budgetTeamName;
  toast.error(team === null ? "Team budget exceeded" : `Team budget exceeded: ${team}`, {
    id: TEAM_BUDGET_TOAST_ID,
    description: (
      <span>
        {error.message}{" "}
        <Link
          href={settingsRoutes.teams()}
          className="font-medium underline underline-offset-3"
          onClick={() => toast.dismiss(TEAM_BUDGET_TOAST_ID)}
        >
          Open team budgets
        </Link>
      </span>
    ),
  });
}
