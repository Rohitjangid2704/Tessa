"use client";

import type { ReactNode } from "react";
import { createDataTableColumnHelper, DataTable } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import type { User } from "@/lib/api/types";
import { TeamChips } from "./team-chips";
import { UserActiveCell } from "./user-active-cell";
import { UserIdentity } from "./user-identity";
import { UserRoleCell } from "./user-role-cell";

const helper = createDataTableColumnHelper<User>();

const USER_COLUMNS = helper.columns([
  helper.display({
    id: "user",
    header: "User",
    cell: (info) => <UserIdentity user={info.row.original} />,
  }),
  helper.display({
    id: "role",
    header: "Role",
    cell: (info) => <UserRoleCell user={info.row.original} />,
  }),
  helper.display({
    id: "status",
    header: "Status",
    cell: (info) => <UserActiveCell user={info.row.original} />,
  }),
  helper.display({
    id: "teams",
    header: "Teams",
    cell: (info) => <TeamChips teamIds={info.row.original.team_ids} />,
  }),
  helper.accessor("last_login_at", {
    header: "Last sign-in",
    enableSorting: false,
    cell: (info) => <DateTime value={info.getValue()} fallback="Never" />,
  }),
  helper.accessor("created_at", {
    header: "Created",
    enableSorting: false,
    cell: (info) => <DateTime value={info.getValue()} />,
  }),
]);

export type UserTableProps = {
  rows: readonly User[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  onRetry: () => void;
  emptyState: ReactNode;
  footer: ReactNode;
};

export function UserTable({
  rows,
  isLoading,
  isFetching,
  error,
  onRetry,
  emptyState,
  footer,
}: UserTableProps) {
  return (
    <DataTable<User>
      label="Users"
      columns={USER_COLUMNS}
      data={rows}
      getRowId={(row) => row.id}
      isLoading={isLoading}
      isFetching={isFetching}
      error={error}
      onRetry={onRetry}
      emptyState={emptyState}
      footer={footer}
      getRowProps={(row) => ({
        "data-user-id": row.id,
        "data-role": row.role,
        "data-active": row.is_active ? "true" : "false",
      })}
    />
  );
}
