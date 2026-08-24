"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { DataTable, createDataTableColumnHelper, type SortingState } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { HealthTick } from "@/components/status/health-tick";
import { Badge } from "@/components/ui/badge";
import { targetRoutes } from "@/lib/routes";
import { appKindLabel } from "../app-kinds";
import type { TargetSummary } from "../types";
import { TargetTierBadge } from "./target-tier-badge";

const helper = createDataTableColumnHelper<TargetSummary>();

const TARGET_COLUMNS = helper.columns([
  helper.accessor("name", {
    header: "Name",
    cell: (info) => (
      <span className="flex items-center gap-2">
        <Link
          href={targetRoutes.detail(info.row.original.id)}
          className="font-medium underline-offset-4 hover:underline"
        >
          {info.getValue()}
        </Link>
        {info.row.original.archived_at ? <Badge variant="outline">Archived</Badge> : null}
      </span>
    ),
  }),
  helper.accessor("app_kind", {
    header: "App kind",
    enableSorting: false,
    cell: (info) => appKindLabel(info.getValue()),
  }),
  helper.accessor("tier", {
    header: "Tier",
    enableSorting: false,
    cell: (info) => <TargetTierBadge tier={info.getValue()} />,
  }),
  helper.accessor("latest_bundle_version", {
    header: "Latest bundle",
    enableSorting: false,
    meta: { align: "end" },
    cell: (info) => {
      const version = info.getValue();
      return version === null ? (
        <span className="text-muted-foreground">None</span>
      ) : (
        <span className="tabular-nums">v{version}</span>
      );
    },
  }),
  helper.accessor("completeness_score", {
    header: "Completeness",
    enableSorting: false,
    meta: { align: "end" },
    cell: (info) => {
      const score = info.getValue();
      return score === null ? (
        <span className="text-muted-foreground">None</span>
      ) : (
        <span className="tabular-nums">{score} / 100</span>
      );
    },
  }),
  helper.accessor("health", {
    header: "Health",
    enableSorting: false,
    cell: (info) => <HealthTick status={info.getValue()} />,
  }),
  helper.accessor("created_at", {
    header: "Created",
    sortDescFirst: true,
    cell: (info) => <DateTime value={info.getValue()} />,
  }),
]);

export type TargetsTableProps = {
  rows: readonly TargetSummary[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  onRetry: () => void;
  sorting: SortingState;
  onSortingChange: (sorting: SortingState) => void;
  emptyState: ReactNode;
  footer: ReactNode;
};

export function TargetsTable({
  rows,
  isLoading,
  isFetching,
  error,
  onRetry,
  sorting,
  onSortingChange,
  emptyState,
  footer,
}: TargetsTableProps) {
  return (
    <DataTable<TargetSummary>
      label="Targets"
      columns={TARGET_COLUMNS}
      data={rows}
      getRowId={(row) => row.id}
      isLoading={isLoading}
      isFetching={isFetching}
      error={error}
      onRetry={onRetry}
      manualSorting
      sorting={sorting}
      onSortingChange={onSortingChange}
      emptyState={emptyState}
      footer={footer}
      getRowProps={(row) => ({
        className: row.archived_at ? "text-muted-foreground" : undefined,
        "data-archived": row.archived_at ? "true" : "false",
      })}
    />
  );
}
