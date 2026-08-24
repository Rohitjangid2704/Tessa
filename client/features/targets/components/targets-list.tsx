"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Target } from "lucide-react";
import Link from "next/link";
import { DataTableFooter } from "@/components/data-table";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { sortingToSortParam, sortParamToSorting } from "@/lib/api/pagination";
import { useCan } from "@/lib/auth/can";
import { targetRoutes } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import { APP_KIND_LABELS, APP_KINDS, TARGET_TIER_LABELS, TARGET_TIERS } from "../app-kinds";
import { targetsListQuery, type TargetListFilters } from "../queries";
import {
  DEFAULT_TARGET_SORT,
  TARGET_SORT_KEYS,
  targetFiltersCodec,
  type TargetFilterValues,
} from "../schemas";
import { TargetsTable } from "./targets-table";

type FilterKey = "q" | "app_kind" | "tier" | "include_archived";

const FILTER_FIELDS: readonly FilterField<FilterKey>[] = [
  { type: "text", key: "q", label: "Search", placeholder: "Name or slug" },
  {
    type: "multi",
    key: "app_kind",
    label: "App kind",
    options: APP_KINDS.map((kind) => ({ value: kind, label: APP_KIND_LABELS[kind] })),
  },
  {
    type: "multi",
    key: "tier",
    label: "Tier",
    options: TARGET_TIERS.map((tier) => ({ value: tier, label: TARGET_TIER_LABELS[tier] })),
  },
  { type: "toggle", key: "include_archived", label: "Include archived" },
];

function toApiFilters(values: TargetFilterValues): TargetListFilters {
  return {
    q: values.q,
    app_kind: values.app_kind,
    tier: values.tier,
    include_archived: values.include_archived,
    sort: values.sort,
  };
}

export function TargetsList() {
  const hydrated = useHydrated();
  const canCreate = useCan("targets.create");
  const { values, setFilters, resetFilters, activeCount } = useUrlFilters(targetFiltersCodec);
  const query = useInfiniteQuery(targetsListQuery(toApiFilters(values)));
  const sorting = sortParamToSorting(values.sort ?? DEFAULT_TARGET_SORT, TARGET_SORT_KEYS);
  const hasFilters =
    values.q !== undefined ||
    (values.app_kind?.length ?? 0) > 0 ||
    (values.tier?.length ?? 0) > 0 ||
    values.include_archived === true;

  const emptyState = hasFilters ? (
    <EmptyState
      title="No targets match"
      description="Change or clear the filters to see more targets."
      icon={Target}
    />
  ) : (
    <EmptyState
      title="No targets yet"
      description="Create a target, copy its Discovery prompt into Claude Code and upload the bundle it writes."
      icon={Target}
      action={
        canCreate ? (
          <Button asChild>
            <Link href={targetRoutes.create()}>New target</Link>
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        label="Filter targets"
        fields={FILTER_FIELDS}
        values={values}
        onChange={(patch) => setFilters(patch)}
        onReset={() => resetFilters()}
        activeCount={activeCount}
      />
      <TargetsTable
        rows={hydrated ? query.data?.items : undefined}
        isLoading={!hydrated || query.isPending}
        isFetching={hydrated && query.isFetching}
        error={hydrated ? query.error : null}
        onRetry={() => void query.refetch()}
        sorting={sorting}
        onSortingChange={(next) => setFilters({ sort: sortingToSortParam(next) })}
        emptyState={emptyState}
        footer={
          <DataTableFooter
            noun="target"
            loadedCount={hydrated ? (query.data?.loadedCount ?? 0) : 0}
            total={hydrated ? query.data?.total : undefined}
            hasNextPage={hydrated && query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
        }
      />
    </div>
  );
}
