"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Repeat2 } from "lucide-react";
import Link from "next/link";
import { DateTime } from "@/components/date-time";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatPercent } from "@/features/runs/results-format";
import { toTrendData } from "@/features/trends/trend-data";
import { describeApiError } from "@/lib/api/errors";
import type { TrendSeries } from "@/lib/api/types";
import { catalogRoutes, routes, runRoutes, withQuery } from "@/lib/routes";
import { loadStateOf, type DashboardQueryResult } from "../load-state";
import type { KpiTone } from "../mutation-headline";
import { passHatKTrendQuery } from "../queries";
import { KpiTile, KpiValue } from "./kpi-tile";
import { Sparkline } from "./sparkline";

const PERCENT_POINTS = 100;

export type PassKTileProps = {
  targetId: string | null;
  dashboard: DashboardQueryResult;
};

function plansHref(targetId: string | null) {
  return targetId === null
    ? withQuery(routes.catalog, { tab: "plans" })
    : catalogRoutes.plans(targetId);
}

type TrendState = {
  tone: KpiTone;
  statusLabel: string | undefined;
};

function describeTrend(values: readonly number[], latest: number | null): TrendState {
  const current = values.at(-1);
  const previous = values.at(-2);
  if (current !== undefined && previous !== undefined && current < previous) {
    const drop = Math.round((previous - current) * PERCENT_POINTS);
    return { tone: "warn", statusLabel: `Down ${drop} points` };
  }
  if (latest === 1) {
    return { tone: "good", statusLabel: "All passed" };
  }
  return { tone: "neutral", statusLabel: undefined };
}

type PassKTrendProps = {
  targetId: string | null;
  trend: UseQueryResult<TrendSeries, Error>;
  values: readonly number[];
};

function PassKTrend({ targetId, trend, values }: PassKTrendProps) {
  if (targetId === null) {
    return <p className="text-xs text-muted-foreground">Choose a target to see the trend.</p>;
  }
  if (trend.isPending) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading the pass^k trend</span>
        <Skeleton className="h-8 w-40 max-w-full" />
      </div>
    );
  }
  if (trend.isError) {
    const requestId = readRequestId(trend.error);
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          Trend unavailable: {describeApiError(trend.error)}
          {requestId === null ? "" : ` (request ${requestId})`}
        </span>
        <Button type="button" variant="outline" size="xs" onClick={() => void trend.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (values.length < 2) {
    return <p className="text-xs text-muted-foreground">Not enough runs for a trend yet.</p>;
  }
  const first = formatPercent(values[0]);
  const last = formatPercent(values.at(-1));
  return (
    <Sparkline
      values={values}
      label={`pass^k over the last ${values.length} runs, from ${first} to ${last}`}
    />
  );
}

export function PassKTile({ targetId, dashboard }: PassKTileProps) {
  const trend = useQuery({ ...passHatKTrendQuery(targetId ?? ""), enabled: targetId !== null });
  const nightly = dashboard.data?.last_nightly ?? null;
  const values = toTrendData(trend.data?.points ?? []).map((datum) => datum.value);
  const { tone, statusLabel } = describeTrend(values, nightly?.pass_hat_k ?? null);

  return (
    <KpiTile
      title="Last nightly pass^k"
      icon={Repeat2}
      tone={nightly === null ? "neutral" : tone}
      statusLabel={statusLabel}
      load={loadStateOf(dashboard)}
      data-tile="passk"
      footer={
        nightly === null ? undefined : (
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            <Link
              href={runRoutes.detail(nightly.run_id)}
              className="font-medium underline-offset-4 hover:underline"
            >
              Open the run
            </Link>
            <Link
              href={runRoutes.trends({ target_id: targetId })}
              className="font-medium underline-offset-4 hover:underline"
            >
              All trends
            </Link>
          </span>
        )
      }
    >
      {nightly === null ? (
        <div data-slot="no-nightly" className="flex flex-col items-start gap-2">
          <p className="text-base font-medium">No nightly run yet</p>
          <p className="text-sm text-muted-foreground">
            Schedule the nightly tier of a saved plan. Its pass^k appears here after the first run.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href={plansHref(targetId)}>Create a schedule</Link>
          </Button>
        </div>
      ) : (
        <>
          <KpiValue
            value={formatPercent(nightly.pass_hat_k)}
            detail={
              <>
                Finished <DateTime value={nightly.finished_at} />
              </>
            }
          />
          <div data-slot="passk-trend">
            <PassKTrend targetId={targetId} trend={trend} values={values} />
          </div>
        </>
      )}
    </KpiTile>
  );
}
