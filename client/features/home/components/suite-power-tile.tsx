"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { formatPercent } from "@/features/runs/results-format";
import { mutationRoutes } from "@/lib/routes";
import { loadStateOf, type DashboardQueryResult } from "../load-state";
import { describeMutationHeadline } from "../mutation-headline";
import { mutationSummaryQuery } from "../queries";
import { KpiTile, KpiValue } from "./kpi-tile";

export type SuitePowerTileProps = {
  targetId: string | null;
  dashboard: DashboardQueryResult;
};

function OpenMutationLink({ targetId }: { targetId: string | null }) {
  return (
    <Link
      href={mutationRoutes.list(targetId)}
      className="font-medium underline-offset-4 hover:underline"
    >
      Open mutation
    </Link>
  );
}

function SuitePowerValue({ killed, total }: { killed: number; total: number }) {
  if (total === 0) {
    return (
      <KpiValue
        value="No mutants"
        detail="Register known bugs to measure how many the suite kills."
      />
    );
  }
  return <KpiValue value={`${killed} of ${total}`} detail="known bugs killed" />;
}

export function SuitePowerTile({ targetId, dashboard }: SuitePowerTileProps) {
  const summary = useQuery({ ...mutationSummaryQuery(targetId ?? ""), enabled: targetId !== null });

  if (targetId === null) {
    const power = dashboard.data?.suite_power ?? null;
    return (
      <KpiTile
        title="Suite power"
        icon={ShieldCheck}
        load={loadStateOf(dashboard)}
        footer={<OpenMutationLink targetId={null} />}
        data-tile="suite-power"
      >
        <KpiValue
          value={power === null ? "n/a" : formatPercent(power)}
          detail="of known bugs killed. Choose a target to see the counts."
        />
      </KpiTile>
    );
  }

  const headline = summary.data === undefined ? null : describeMutationHeadline(summary.data);
  return (
    <KpiTile
      title="Suite power"
      icon={ShieldCheck}
      tone={headline?.tone}
      statusLabel={headline?.statusLabel}
      load={loadStateOf(summary)}
      footer={<OpenMutationLink targetId={targetId} />}
      data-tile="suite-power"
    >
      {summary.data === undefined ? null : (
        <SuitePowerValue killed={summary.data.killed} total={summary.data.total} />
      )}
    </KpiTile>
  );
}
