"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { createDataTableColumnHelper, DataTable } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { BudgetMeter } from "@/components/status/budget-meter";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import { VerdictBar } from "@/components/status/verdict-bar";
import { Badge } from "@/components/ui/badge";
import { TargetName } from "@/features/targets/components/target-name";
import { formatDuration } from "@/lib/format-duration";
import type { RunSummary } from "@/lib/api/types";
import { runGroupRoutes, runRoutes } from "@/lib/routes";
import { isProvisionalBudget } from "../apply-feed-event";
import { RUN_KIND_LABELS } from "../labels";
import { shortRunId } from "../run-status";

const helper = createDataTableColumnHelper<RunSummary>();

const RUN_COLUMNS = helper.columns([
  helper.display({
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
          {run.run_group_id === null ? null : (
            <Badge variant="outline" asChild>
              <Link href={runGroupRoutes.detail(run.run_group_id)}>Run group</Link>
            </Badge>
          )}
        </span>
      );
    },
  }),
  helper.display({
    id: "target",
    header: "Target",
    enableSorting: false,
    cell: (info) => <TargetName targetId={info.row.original.target_id} />,
  }),
  helper.display({
    id: "status",
    header: "Status",
    enableSorting: false,
    cell: (info) => <RunStatusBadge status={info.row.original.status} />,
  }),
  helper.display({
    id: "counters",
    header: "Scenarios",
    enableSorting: false,
    cell: (info) => <VerdictBar counters={info.row.original.counters} hideZero showProgress />,
  }),
  helper.display({
    id: "budget",
    header: "Budget",
    enableSorting: false,
    cell: (info) => {
      const { budget } = info.row.original;
      return isProvisionalBudget(budget) ? (
        <span className="text-muted-foreground">n/a</span>
      ) : (
        <BudgetMeter budget={budget} className="flex-col items-start gap-0.5 text-xs" />
      );
    },
  }),
  helper.display({
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
  }),
  helper.display({
    id: "created",
    header: "Created",
    enableSorting: false,
    cell: (info) => <DateTime value={info.row.original.created_at} />,
  }),
]);

export type RunsTableProps = {
  rows: readonly RunSummary[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  onRetry: () => void;
  emptyState: ReactNode;
  footer: ReactNode;
};

export function RunsTable({
  rows,
  isLoading,
  isFetching,
  error,
  onRetry,
  emptyState,
  footer,
}: RunsTableProps) {
  return (
    <DataTable<RunSummary>
      label="Runs"
      columns={RUN_COLUMNS}
      data={rows}
      getRowId={(row) => row.id}
      isLoading={isLoading}
      isFetching={isFetching}
      error={error}
      onRetry={onRetry}
      emptyState={emptyState}
      footer={footer}
      getRowProps={(row) => ({ "data-run-id": row.id, "data-status": row.status })}
    />
  );
}
