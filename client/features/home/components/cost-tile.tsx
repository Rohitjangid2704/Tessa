"use client";

import { Coins } from "lucide-react";
import Link from "next/link";
import { useCan } from "@/lib/auth/can";
import { formatUsd } from "@/lib/format-usd";
import { settingsRoutes } from "@/lib/routes";
import { loadStateOf, type DashboardQueryResult } from "../load-state";
import { KpiTile, KpiValue } from "./kpi-tile";

export type CostTileProps = {
  dashboard: DashboardQueryResult;
};

export function CostTile({ dashboard }: CostTileProps) {
  const cost = dashboard.data?.cost_week_usd;
  const canManageTeams = useCan("teams.manage");
  return (
    <KpiTile
      title="Cost this week"
      icon={Coins}
      load={loadStateOf(dashboard)}
      footer={
        canManageTeams ? (
          <Link
            href={settingsRoutes.teams()}
            data-slot="team-budgets-link"
            className="underline underline-offset-4"
          >
            Team budgets
          </Link>
        ) : undefined
      }
      data-tile="cost"
    >
      {cost === undefined ? null : (
        <KpiValue value={formatUsd(cost)} detail="Spent by runs this week" />
      )}
    </KpiTile>
  );
}
