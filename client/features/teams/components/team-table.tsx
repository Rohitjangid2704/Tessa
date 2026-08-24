"use client";

import type { ReactNode } from "react";
import { createDataTableColumnHelper, DataTable } from "@/components/data-table";
import type { Team } from "@/lib/api/types";
import { describeMemberCount, spendStateOf } from "../labels";
import { SpendBar } from "./spend-bar";
import { TeamActions } from "./team-actions";

const helper = createDataTableColumnHelper<Team>();

const TEAM_COLUMNS = helper.columns([
  helper.accessor("name", {
    header: "Team",
    enableSorting: false,
    cell: (info) => <span className="font-medium wrap-anywhere">{info.getValue()}</span>,
  }),
  helper.accessor("member_count", {
    header: "Members",
    enableSorting: false,
    cell: (info) => (
      <span className="whitespace-nowrap tabular-nums">{describeMemberCount(info.getValue())}</span>
    ),
  }),
  helper.display({
    id: "spend",
    header: "Spend this month",
    enableSorting: false,
    cell: (info) => <SpendBar team={info.row.original} />,
  }),
  helper.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    enableSorting: false,
    meta: { align: "end" },
    cell: (info) => <TeamActions team={info.row.original} />,
  }),
]);

export type TeamTableProps = {
  rows: readonly Team[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  onRetry: () => void;
  emptyState: ReactNode;
  footer?: ReactNode;
};

export function TeamTable({
  rows,
  isLoading,
  isFetching,
  error,
  onRetry,
  emptyState,
  footer,
}: TeamTableProps) {
  return (
    <DataTable<Team>
      label="Teams"
      columns={TEAM_COLUMNS}
      data={rows}
      getRowId={(row) => row.id}
      isLoading={isLoading}
      isFetching={isFetching}
      error={error}
      onRetry={onRetry}
      emptyState={emptyState}
      footer={footer}
      skeletonRows={3}
      getRowProps={(row) => ({
        "data-team-id": row.id,
        "data-spend-state": spendStateOf(row),
      })}
    />
  );
}
