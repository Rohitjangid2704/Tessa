"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { DataTableFooter } from "@/components/data-table";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { PermissionDenied } from "@/components/permission-denied";
import { EmptyState } from "@/components/states/empty-state";
import { isApiError } from "@/lib/api/errors";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import { ACTIVE_FILTER_LABELS, ROLE_LABELS } from "../labels";
import { usersListQuery, type UserListFilters } from "../queries";
import {
  ACTIVE_FILTER_VALUES,
  activeFilterOf,
  USER_ROLES,
  userFiltersCodec,
  type UserFilterValues,
} from "../schemas";
import { SingleUserNotice } from "./single-user-notice";
import { UserTable } from "./user-table";

type FilterKey = "q" | "role" | "is_active";

const FILTER_FIELDS: readonly FilterField<FilterKey>[] = [
  { type: "text", key: "q", label: "Search", placeholder: "Name or email" },
  {
    type: "multi",
    key: "role",
    label: "Role",
    options: USER_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
  },
  {
    type: "multi",
    key: "is_active",
    label: "Status",
    options: ACTIVE_FILTER_VALUES.map((value) => ({
      value,
      label: ACTIVE_FILTER_LABELS[value],
    })),
  },
];

function toApiFilters(values: UserFilterValues): UserListFilters {
  return {
    q: values.q,
    role: values.role,
    is_active: activeFilterOf(values.is_active),
  };
}

export function UsersView() {
  const hydrated = useHydrated();
  const { values, setFilters, resetFilters, activeCount } = useUrlFilters(userFiltersCodec);
  const query = useInfiniteQuery(usersListQuery(toApiFilters(values)));
  const hasFilters = activeCount > 0;

  if (query.isError && isApiError(query.error) && query.error.status === 403) {
    return <PermissionDenied action="users.manage" />;
  }

  const loaded = hydrated ? query.data : undefined;
  const isOnlyUser =
    !hasFilters && loaded !== undefined && (loaded.total ?? loaded.loadedCount) === 1;

  const emptyState = hasFilters ? (
    <EmptyState
      title="No users match"
      description="Change or clear the filters to see more users."
      icon={Users}
    />
  ) : (
    <EmptyState
      title="No users yet"
      description="Create the first account with New user."
      icon={Users}
    />
  );

  return (
    <div className="flex flex-col gap-4" data-slot="users-view">
      <FilterBar
        label="Filter users"
        fields={FILTER_FIELDS}
        values={values}
        onChange={(patch) => setFilters(patch)}
        onReset={() => resetFilters()}
        activeCount={activeCount}
      />
      <UserTable
        rows={loaded?.items}
        isLoading={!hydrated || query.isPending}
        isFetching={hydrated && query.isFetching}
        error={hydrated ? query.error : null}
        onRetry={() => void query.refetch()}
        emptyState={emptyState}
        footer={
          <DataTableFooter
            noun="user"
            loadedCount={loaded?.loadedCount ?? 0}
            total={loaded?.total}
            hasNextPage={hydrated && query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
        }
      />
      {isOnlyUser ? <SingleUserNotice /> : null}
    </div>
  );
}
