"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DateTime, formatDateTime } from "@/components/date-time";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TrendMetric, TrendPoint } from "@/lib/api/types";
import { runRoutes } from "@/lib/routes";
import { TREND_METRIC_INFO } from "./labels";
import { toTrendData } from "./trend-data";

const TrendChartCanvas = dynamic(
  () => import("./trend-chart-canvas").then((module) => module.TrendChartCanvas),
  {
    ssr: false,
    loading: () => (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading the chart</span>
        <Skeleton className="h-50 w-full" />
      </div>
    ),
  },
);

export type TrendChartProps = {
  metric: TrendMetric;
  points: readonly TrendPoint[];
};

export function TrendChart({ metric, points }: TrendChartProps) {
  const router = useRouter();
  const [showTable, setShowTable] = useState(false);
  const info = TREND_METRIC_INFO[metric];
  const data = toTrendData(points);
  const first = data[0];
  const latest = data.at(-1);
  const summary =
    first === undefined || latest === undefined
      ? `${info.label}: no data`
      : `${info.label} over ${data.length} runs from ${formatDateTime(first.ts) ?? first.ts} to ${formatDateTime(latest.ts) ?? latest.ts}. Latest ${info.format(latest.value)}.`;

  return (
    <div data-slot="trend-chart" data-metric={metric} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-2xl font-semibold tabular-nums" data-slot="trend-latest">
          {latest === undefined ? "n/a" : info.format(latest.value)}
          <span className="ml-2 text-xs font-normal text-muted-foreground">latest</span>
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={showTable}
          onClick={() => setShowTable((current) => !current)}
        >
          {showTable ? "View as chart" : "View as table"}
        </Button>
      </div>
      {showTable ? (
        <Table data-slot="trend-table" aria-label={`${info.label} by run`}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Date</TableHead>
              <TableHead scope="col" className="text-right">
                {info.label}
              </TableHead>
              <TableHead scope="col">Run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...data].reverse().map((datum) => (
              <TableRow key={`${datum.ts}:${datum.runId ?? "none"}`}>
                <TableCell>
                  <DateTime value={datum.ts} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{info.format(datum.value)}</TableCell>
                <TableCell>
                  {datum.runId === null ? (
                    <span className="text-muted-foreground">No run link</span>
                  ) : (
                    <Link
                      href={runRoutes.detail(datum.runId)}
                      className="font-medium underline underline-offset-4"
                    >
                      Open run
                    </Link>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div role="img" aria-label={summary} data-slot="trend-canvas">
          <TrendChartCanvas
            data={data}
            label={info.label}
            color={info.color}
            fractional={info.fractional}
            formatValue={info.format}
            onSelectRun={(runId) => router.push(runRoutes.detail(runId))}
          />
        </div>
      )}
    </div>
  );
}
