"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { ListChecks, SearchX } from "lucide-react";
import Link from "next/link";
import { DataTableFooter } from "@/components/data-table";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { filterOptions } from "@/features/runs/labels";
import { TargetFilterSelect } from "@/features/targets/components/target-filter-select";
import { sortingToSortParam, sortParamToSorting } from "@/lib/api/pagination";
import { routes, withQuery } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import {
  DEFAULT_SCENARIO_SORT,
  SCENARIO_ORIGIN_LABELS,
  SCENARIO_ORIGINS,
  SCENARIO_SORT_KEYS,
  SCENARIO_STATUS_LABELS,
  SCENARIO_STATUSES,
} from "../labels";
import { scenariosListQuery, toScenarioListFilters } from "../queries";
import { scenarioFiltersCodec } from "../schemas";
import { isQuarantinedOnly, QUARANTINED_STATUS, QuarantinedFilter } from "./quarantined-filter";
import { ScenariosTable } from "./scenarios-table";

type FilterKey = "q" | "status" | "origin" | "family" | "feature_id" | "include_synthetic";

const FILTER_FIELDS: readonly FilterField<FilterKey>[] = [
  { type: "text", key: "q", label: "Search", placeholder: "Title or text" },
  {
    type: "multi",
    key: "status",
    label: "Status",
    options: filterOptions(SCENARIO_STATUSES, SCENARIO_STATUS_LABELS),
  },
  {
    type: "multi",
    key: "origin",
    label: "Origin",
    options: filterOptions(SCENARIO_ORIGINS, SCENARIO_ORIGIN_LABELS),
  },
  { type: "text", key: "family", label: "Family", placeholder: "Family name" },
  { type: "text", key: "feature_id", label: "Feature", placeholder: "Feature id" },
  { type: "toggle", key: "include_synthetic", label: "Show synthetic" },
];

export function ScenariosView() {
  const hydrated = useHydrated();
  const { values, setFilters, resetFilters, activeCount } = useUrlFilters(scenarioFiltersCodec);
  const query = useInfiniteQuery(scenariosListQuery(toScenarioListFilters(values)));
  const sorting = sortParamToSorting(values.sort ?? DEFAULT_SCENARIO_SORT, SCENARIO_SORT_KEYS);

  const emptyState =
    activeCount > 0 ? (
      <EmptyState
        title="No scenarios match"
        description={
          values.include_synthetic === true
            ? "Change or clear the filters to see more scenarios."
            : "Change or clear the filters to see more scenarios. Synthetic scenarios Tessa generates itself are hidden until you turn on Show synthetic."
        }
        icon={SearchX}
        action={
          <Button variant="outline" onClick={() => resetFilters()}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState
        title="No scenarios yet"
        description="Scenarios appear here when you save a plan or run features from the catalog. Each selected feature, role and interface becomes one scenario."
        icon={ListChecks}
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
    <div data-slot="scenarios-view" className="flex flex-col gap-4">
      <FilterBar
        label="Filter scenarios"
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
        <QuarantinedFilter
          pressed={isQuarantinedOnly(values.status)}
          onToggle={(next) => setFilters({ status: next ? [QUARANTINED_STATUS] : undefined })}
        />
      </FilterBar>
      <ScenariosTable
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
            noun="scenario"
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
