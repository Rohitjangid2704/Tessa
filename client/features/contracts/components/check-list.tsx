"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { GitCompareArrows } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { createDataTableColumnHelper, DataTable, DataTableFooter } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { FilterBar } from "@/components/filter-bar";
import { EmptyState } from "@/components/states/empty-state";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import { Button } from "@/components/ui/button";
import type { ContractCheck } from "@/lib/api/types";
import { contractRoutes, runRoutes } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import { describeCheckOutcome, countVerdicts } from "../model";
import { contractChecksListQuery } from "../queries";
import { contractListFiltersCodec } from "../schemas";
import { BundleChip } from "./bundle-chip";
import { ContractVerdictBadge } from "./contract-verdict-badge";
import { TargetFilter } from "./target-filter";

const helper = createDataTableColumnHelper<ContractCheck>();

function ResultCell({ check }: { check: ContractCheck }) {
  const outcome = describeCheckOutcome(check);
  if (outcome === "in_progress") {
    return (
      <span className="text-muted-foreground">
        In progress, <span className="tabular-nums">{check.breaking}</span> breaking so far
      </span>
    );
  }
  if (outcome === "unfinished") {
    return <span className="text-muted-foreground">Did not finish</span>;
  }
  if (outcome === "breaking") {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <ContractVerdictBadge verdict="fail" />
        <span className="tabular-nums">{check.breaking} breaking</span>
      </span>
    );
  }
  if (outcome === "undecided") {
    const { uncertain } = countVerdicts(check.items);
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <ContractVerdictBadge verdict="uncertain" />
        <span className="tabular-nums">{uncertain} undecided</span>
      </span>
    );
  }
  return <ContractVerdictBadge verdict="pass" />;
}

const CHECK_COLUMNS = helper.columns([
  helper.display({
    id: "started",
    header: "Started",
    enableSorting: false,
    cell: (info) => (
      <Link
        href={contractRoutes.detail(info.row.original.id)}
        className="font-medium underline-offset-4 hover:underline"
      >
        <DateTime value={info.row.original.created_at} />
      </Link>
    ),
  }),
  helper.display({
    id: "consumer",
    header: "Consumer",
    enableSorting: false,
    cell: (info) => <BundleChip bundleId={info.row.original.consumer_bundle_id} />,
  }),
  helper.display({
    id: "provider",
    header: "Provider",
    enableSorting: false,
    cell: (info) => <BundleChip bundleId={info.row.original.provider_bundle_id} />,
  }),
  helper.display({
    id: "result",
    header: "Result",
    enableSorting: false,
    cell: (info) => <ResultCell check={info.row.original} />,
  }),
  helper.display({
    id: "status",
    header: "Run status",
    enableSorting: false,
    cell: (info) => <RunStatusBadge status={info.row.original.status} />,
  }),
  helper.display({
    id: "run",
    header: "Run",
    enableSorting: false,
    cell: (info) => (
      <Link
        href={runRoutes.detail(info.row.original.run_id)}
        className="text-sm underline underline-offset-4"
      >
        Open the run
      </Link>
    ),
  }),
]);

export function CheckList() {
  const headingId = useId();
  const hydrated = useHydrated();
  const { values, activeCount, setFilters, resetFilters } = useUrlFilters(contractListFiltersCodec);
  const query = useInfiniteQuery(
    contractChecksListQuery({
      consumer_target_id: values.consumer_target_id,
      provider_target_id: values.provider_target_id,
    }),
  );
  const rows = hydrated ? query.data?.items : undefined;
  const filtered = activeCount > 0;

  return (
    <section
      aria-labelledby={headingId}
      data-slot="contract-check-list"
      className="flex flex-col gap-4"
    >
      <h2 id={headingId} className="text-base font-semibold">
        Earlier checks
      </h2>
      <FilterBar
        label="Contract check filters"
        fields={[]}
        values={values}
        onChange={(patch) => setFilters(patch)}
        onReset={() => resetFilters()}
        activeCount={activeCount}
      >
        <TargetFilter
          label="Consumer target"
          value={values.consumer_target_id}
          onChange={(targetId) => setFilters({ consumer_target_id: targetId })}
        />
        <TargetFilter
          label="Provider target"
          value={values.provider_target_id}
          onChange={(targetId) => setFilters({ provider_target_id: targetId })}
        />
      </FilterBar>
      <DataTable<ContractCheck>
        label="Contract checks"
        columns={CHECK_COLUMNS}
        data={rows}
        getRowId={(row) => row.id}
        isLoading={!hydrated || query.isPending}
        isFetching={hydrated && query.isFetching}
        error={hydrated ? query.error : null}
        onRetry={() => void query.refetch()}
        emptyState={
          filtered ? (
            <EmptyState
              icon={GitCompareArrows}
              title="No checks match these filters"
              description="Clear a filter to see more checks."
              action={
                <Button type="button" variant="outline" onClick={() => resetFilters()}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={GitCompareArrows}
              title="No contract checks yet"
              description="Start a check above to compare what one app sends with what another accepts."
            />
          )
        }
        getRowProps={(row) => ({
          "data-check-id": row.id,
          "data-status": row.status,
          "data-breaking": row.breaking,
        })}
        footer={
          <DataTableFooter
            noun="check"
            loadedCount={rows?.length ?? 0}
            total={hydrated ? (query.data?.total ?? null) : null}
            hasNextPage={hydrated && query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
        }
      />
    </section>
  );
}
