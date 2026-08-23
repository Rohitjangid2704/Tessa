"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import Link from "next/link";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  calibrationReportQuery,
  totalCalibrationLabels,
} from "@/features/labels/calibration-queries";
import { describeApiError } from "@/lib/api/errors";
import type { CalibrationReport } from "@/lib/api/types";
import { labelRoutes } from "@/lib/routes";
import { loadStateOf, type DashboardQueryResult } from "../load-state";
import { KpiTile, KpiValue } from "./kpi-tile";

const KAPPA_DECIMALS = 2;

export type KappaTileProps = {
  targetId: string | null;
  dashboard: DashboardQueryResult;
};

export function formatKappa(kappa: number): string {
  return kappa.toFixed(KAPPA_DECIMALS);
}

function LabelCount({ calibration }: { calibration: UseQueryResult<CalibrationReport, Error> }) {
  if (calibration.isPending) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Counting labels</span>
        <Skeleton className="h-4 w-32" />
      </div>
    );
  }
  if (calibration.isError) {
    const requestId = readRequestId(calibration.error);
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          Label count unavailable: {describeApiError(calibration.error)}
          {requestId === null ? "" : ` (request ${requestId})`}
        </span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void calibration.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  const total = totalCalibrationLabels(calibration.data);
  return (
    <p data-slot="kappa-n-labels" className="text-sm text-muted-foreground">
      Based on {total.toLocaleString("en-US")} {total === 1 ? "label" : "labels"}
    </p>
  );
}

export function KappaTile({ targetId, dashboard }: KappaTileProps) {
  const calibration = useQuery(calibrationReportQuery(targetId));
  const kappa = dashboard.data?.kappa;

  return (
    <KpiTile
      title="Judge agreement (kappa)"
      icon={Scale}
      load={loadStateOf(dashboard)}
      data-tile="kappa"
      footer={
        <Link
          href={labelRoutes.tab("calibration", { target_id: targetId })}
          className="font-medium underline-offset-4 hover:underline"
        >
          Open calibration
        </Link>
      }
    >
      {kappa === undefined ? null : (
        <>
          {kappa === null ? (
            <div className="flex flex-col gap-1">
              <p data-slot="kappa-null" className="text-lg font-semibold">
                Not enough labels
              </p>
              <p className="text-sm text-muted-foreground">
                Label more judge and probe grades to get a kappa.
              </p>
            </div>
          ) : (
            <KpiValue
              value={formatKappa(kappa)}
              detail="Agreement of the machine grades with yours"
            />
          )}
          <LabelCount calibration={calibration} />
        </>
      )}
    </KpiTile>
  );
}
