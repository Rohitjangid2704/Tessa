"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Play, SearchX } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DataTableFooter } from "@/components/data-table";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { RUN_STATUSES } from "@/components/status/status-types";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { TargetFilterSelect } from "@/features/targets/components/target-filter-select";
import { routes, withQuery } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import { filterOptions, RUN_KIND_LABELS, RUN_KINDS, RUN_STATUS_LABELS } from "../labels";
import { runsListQuery, type RunListFilters } from "../queries";
import { runFiltersCodec, type RunFilterValues } from "../schemas";
import { RunsFeed } from "./runs-feed";
import { RunsTable } from "./runs-table";

type FilterKey = "status" | "kind";

const FILTER_FIELDS: readonly FilterField<FilterKey>[] = [
  {
    type: "multi",
    key: "status",
    label: "Status",
    options: filterOptions(RUN_STATUSES, RUN_STATUS_LABELS),
  },
  { type: "multi", key: "kind", label: "Kind", options: filterOptions(RUN_KINDS, RUN_KIND_LABELS) },
];

function toApiFilters(values: RunFilterValues): RunListFilters {
  return { target_id: values.target_id, status: values.status, kind: values.kind };
}

export function RunsListView() {
  const hydrated = useHydrated();
  const { values, setFilters, resetFilters, activeCount } = useUrlFilters(runFiltersCodec);
  const [feedGeneration, setFeedGeneration] = useState(0);
  const filters = toApiFilters(values);
  const query = useInfiniteQuery(runsListQuery(filters));

  const emptyState =
    activeCount > 0 ? (
      <EmptyState
        title="No runs match"
        description="Change or clear the filters to see more runs. New runs that match appear here as they start."
        icon={SearchX}
        action={
          <Button variant="outline" onClick={() => resetFilters()}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState
        title="No runs yet"
        description="Select features in the catalog and start a run. It shows up here the moment it is created."
        icon={Play}
        action={
          <Button asChild>
            <Link href={withQuery(routes.catalog, { target_id: values.target_id })}>
              Open the catalog
            </Link>
          </Button>
        }
      />
    );

  return (
    <div data-slot="runs-list" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FilterBar
          label="Filter runs"
          fields={FILTER_FIELDS}
          values={values}
          onChange={(patch) => setFilters(patch)}
          onReset={() => resetFilters()}
          activeCount={activeCount}
        >
          <TargetFilterSelect
            value={values.target_id}
            onChange={(targetId) => setFilters({ target_id: targetId })}
          />
        </FilterBar>
        <RunsFeed
          key={feedGeneration}
          filters={filters}
          onRestart={() => setFeedGeneration((generation) => generation + 1)}
        />
      </div>
      <RunsTable
        rows={hydrated ? query.data?.items : undefined}
        isLoading={!hydrated || query.isPending}
        isFetching={hydrated && query.isFetching}
        error={hydrated ? query.error : null}
        onRetry={() => void query.refetch()}
        emptyState={emptyState}
        footer={
          <DataTableFooter
            noun="run"
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
