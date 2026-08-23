"use client";

import { Play } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { createDataTableColumnHelper, DataTable } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { EmptyState } from "@/components/states/empty-state";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import { VerdictBar } from "@/components/status/verdict-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RUN_KIND_LABELS } from "@/features/runs/labels";
import { shortRunId } from "@/features/runs/run-status";
import { TargetName } from "@/features/targets/components/target-name";
import { formatDuration } from "@/lib/format-duration";
import type { RunSummary } from "@/lib/api/types";
import { routes, runRoutes, withQuery } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { DashboardQueryResult } from "../load-state";

const helper = createDataTableColumnHelper<RunSummary>();

const RUN_COLUMN = helper.display({
  id: "run",
  header: "Run",
  enableSorting: false,
  cell: (info) => {
    const run = info.row.original;
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Link
          href={runRoutes.detail(run.id)}
          className="font-medium underline-offset-4 hover:underline"
        >
          {RUN_KIND_LABELS[run.kind]} run{" "}
          <span className="font-mono text-xs">{shortRunId(run.id)}</span>
        </Link>
        {run.read_only ? <Badge variant="outline">Read-only</Badge> : null}
      </span>
    );
  },
});

const TARGET_COLUMN = helper.display({
  id: "target",
  header: "Target",
  enableSorting: false,
  cell: (info) => <TargetName targetId={info.row.original.target_id} />,
});

const STATUS_COLUMN = helper.display({
  id: "status",
  header: "Status",
  enableSorting: false,
  cell: (info) => <RunStatusBadge status={info.row.original.status} />,
});

const COUNTERS_COLUMN = helper.display({
  id: "counters",
  header: "Scenarios",
  enableSorting: false,
  cell: (info) => <VerdictBar counters={info.row.original.counters} hideZero showProgress />,
});

const DURATION_COLUMN = helper.display({
  id: "duration",
  header: "Duration",
  enableSorting: false,
  meta: { align: "end" },
  cell: (info) => {
    const run = info.row.original;
    return run.started_at === null ? (
      <span className="text-muted-foreground">Not started</span>
    ) : (
      <span className="tabular-nums">{formatDuration(run.budget.elapsed_ms)}</span>
    );
  },
});

const CREATED_COLUMN = helper.display({
  id: "created",
  header: "Created",
  enableSorting: false,
  cell: (info) => <DateTime value={info.row.original.created_at} />,
});

const COLUMNS_WITH_TARGET = helper.columns([
  RUN_COLUMN,
  TARGET_COLUMN,
  STATUS_COLUMN,
  COUNTERS_COLUMN,
  DURATION_COLUMN,
  CREATED_COLUMN,
]);

const COLUMNS_WITHOUT_TARGET = helper.columns([
  RUN_COLUMN,
  STATUS_COLUMN,
  COUNTERS_COLUMN,
  DURATION_COLUMN,
  CREATED_COLUMN,
]);

export type LastRunsTableProps = {
  targetId: string | null;
  dashboard: DashboardQueryResult;
  className?: string;
};

export function LastRunsTable({ targetId, dashboard, className }: LastRunsTableProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-slot="last-runs"
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          Last runs
        </h2>
        <Link
          href={runRoutes.list({ target_id: targetId })}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          All runs
        </Link>
      </div>
      <DataTable<RunSummary>
        label="Last runs"
        columns={targetId === null ? COLUMNS_WITH_TARGET : COLUMNS_WITHOUT_TARGET}
        data={dashboard.data?.last_runs}
        getRowId={(row) => row.id}
        isLoading={dashboard.isPending}
        isFetching={dashboard.isFetching}
        error={dashboard.error}
        onRetry={() => void dashboard.refetch()}
        skeletonRows={3}
        getRowProps={(row) => ({ "data-run-id": row.id, "data-status": row.status })}
        emptyState={
          <EmptyState
            title="No runs yet"
            description="Runs of your plans show up here as they start and finish."
            icon={Play}
            action={
              <Button asChild>
                <Link href={withQuery(routes.catalog, { target_id: targetId })}>
                  Open the catalog
                </Link>
              </Button>
            }
          />
        }
      />
    </section>
  );
}
