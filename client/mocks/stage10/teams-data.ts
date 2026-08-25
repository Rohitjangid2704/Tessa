import { STAGE_ONE_IDS } from "../stage1/seed";
import { STAGE_TEN_TEAM_IDS } from "./users-data";

export const TEAM_IDS = STAGE_TEN_TEAM_IDS;

export const TEAMS_VARIANTS = ["default", "within_budget", "empty"] as const;

export type TeamsVariant = (typeof TEAMS_VARIANTS)[number];

export interface SeededTeam {
  id: string;
  name: string;
  maxUsdMonth: number | null;
  spentMonthUsd: number;
  createdAt: string;
  targetIds: readonly string[];
}

const OVER_BUDGET_SPEND_USD = 52.18;
const WITHIN_BUDGET_SPEND_USD = 18.35;

export function seededTeams(variant: TeamsVariant): SeededTeam[] {
  if (variant === "empty") {
    return [];
  }
  return [
    {
      id: TEAM_IDS.platform,
      name: "Platform QA",
      maxUsdMonth: 150,
      spentMonthUsd: 61.42,
      createdAt: "2026-06-01T08:30:00.000Z",
      targetIds: [
        STAGE_ONE_IDS.gracie,
        STAGE_ONE_IDS.liveShop,
        STAGE_ONE_IDS.brokenImport,
        STAGE_ONE_IDS.legacyPortal,
      ],
    },
    {
      id: TEAM_IDS.growth,
      name: "Growth",
      maxUsdMonth: 40,
      spentMonthUsd: variant === "within_budget" ? WITHIN_BUDGET_SPEND_USD : OVER_BUDGET_SPEND_USD,
      createdAt: "2026-07-14T10:00:00.000Z",
      targetIds: [STAGE_ONE_IDS.billing],
    },
    {
      id: TEAM_IDS.mobile,
      name: "Mobile",
      maxUsdMonth: null,
      spentMonthUsd: 7.9,
      createdAt: "2026-08-03T09:15:00.000Z",
      targetIds: [],
    },
  ];
}
