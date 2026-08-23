"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { createDataTableColumnHelper, DataTable } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { CompletenessBadge, ValidationBadge } from "@/features/bundles/components/bundle-badges";
import { describeSource, shortHash } from "@/features/bundles/format";
import { appKindLabel } from "@/features/targets/app-kinds";
import type { LibraryBundle } from "@/lib/api/types";
import { targetRoutes } from "@/lib/routes";
import { LibraryRowActions } from "./library-row-actions";

const helper = createDataTableColumnHelper<LibraryBundle>();

const LIBRARY_COLUMNS = helper.columns([
  helper.accessor("target_name", {
    header: "Target",
    enableSorting: false,
    cell: (info) => (
      <Link
        href={targetRoutes.detail(info.row.original.target_id)}
        className="font-medium underline-offset-4 hover:underline"
      >
        {info.getValue()}
      </Link>
    ),
  }),
  helper.accessor("app_kind", {
    header: "App kind",
    enableSorting: false,
    cell: (info) => appKindLabel(info.getValue()),
  }),
  helper.accessor("version", {
    header: "Version",
    enableSorting: false,
    cell: (info) => (
      <span className="flex flex-wrap items-center gap-2">
        <Link
          href={targetRoutes.bundle(info.row.original.target_id, info.row.original.id)}
          className="font-medium underline underline-offset-4"
        >
          Version {info.getValue()}
        </Link>
        {info.row.original.validation_status === "invalid" ? (
          <ValidationBadge status="invalid" />
        ) : null}
      </span>
    ),
  }),
  helper.accessor("hash", {
    header: "Hash",
    enableSorting: false,
    cell: (info) => (
      <code className="font-mono text-xs" title={info.getValue()}>
        {shortHash(info.getValue())}
      </code>
    ),
  }),
  helper.display({
    id: "completeness",
    header: "Completeness",
    enableSorting: false,
    cell: (info) => (
      <span className="flex flex-wrap items-center gap-2">
        <span className="tabular-nums">{info.row.original.completeness_score} of 100</span>
        <CompletenessBadge status={info.row.original.completeness_status} />
      </span>
    ),
  }),
  helper.accessor("feature_count", {
    header: "Features",
    enableSorting: false,
    meta: { align: "end" },
    cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
  }),
  helper.accessor("source", {
    header: "Source",
    enableSorting: false,
    cell: (info) => describeSource(info.getValue()),
  }),
  helper.accessor("uploaded_at", {
    header: "Uploaded",
    enableSorting: false,
    cell: (info) => <DateTime value={info.getValue()} />,
  }),
  helper.display({
    id: "actions",
    header: "Actions",
    enableSorting: false,
    cell: (info) => <LibraryRowActions bundle={info.row.original} />,
  }),
]);

export type LibraryTableProps = {
  rows: readonly LibraryBundle[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  onRetry: () => void;
  emptyState: ReactNode;
  footer: ReactNode;
};

export function LibraryTable({
  rows,
  isLoading,
  isFetching,
  error,
  onRetry,
  emptyState,
  footer,
}: LibraryTableProps) {
  return (
    <DataTable<LibraryBundle>
      label="Bundle library"
      columns={LIBRARY_COLUMNS}
      data={rows}
      getRowId={(row) => row.id}
      isLoading={isLoading}
      isFetching={isFetching}
      error={error}
      onRetry={onRetry}
      emptyState={emptyState}
      footer={footer}
      getRowProps={(row) => ({
        "data-bundle-id": row.id,
        "data-target-id": row.target_id,
        "data-validation": row.validation_status,
      })}
    />
  );
}
