"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { CircleHelp, ListChecks, SearchX, TriangleAlert } from "lucide-react";
import { Suspense, useId } from "react";
import { DataTableFooter } from "@/components/data-table";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { StatusBadge } from "@/components/status/status-badge";
import { VERDICT_STATUSES } from "@/components/status/status-types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { pluralize } from "@/features/bundles/format";
import { describeApiError } from "@/lib/api/errors";
import type { RunScenarioSummary } from "@/lib/api/types";
import { useUrlFilters } from "@/lib/url-state";
import {
  filterOptions,
  RUN_SCENARIO_STATUS_LABELS,
  RUN_SCENARIO_STATUSES,
  textFilterOptions,
  VERDICT_LABELS,
} from "../labels";
import { runScenarioFacetsQuery, runScenariosQuery, type RunScenarioFilters } from "../queries";
import { runScenarioFiltersCodec, type RunScenarioFilterValues } from "../schemas";
import { describeSkipReason, tallyLoudSkips } from "../skip-reasons";
import { useRunStreamState } from "../use-run-stream";
import { ScenarioRow } from "./scenario-row";

type FilterKey = "status" | "verdict" | "family" | "role";

const PREPARING_STATUSES = ["queued", "planning", "seeding"];

function toApiFilters(values: RunScenarioFilterValues): RunScenarioFilters {
  return {
    status: values.status,
    verdict: values.verdict,
    family: values.family,
    role: values.role,
  };
}

function ScenarioListSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-2">
      <span className="sr-only">Loading scenarios</span>
      <Skeleton className="h-8 w-full max-w-md" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function LoudSkipSummary({ items }: { items: readonly RunScenarioSummary[] }) {
  const tallies = tallyLoudSkips(items);
  if (tallies.length === 0) {
    return null;
  }
  return (
    <Alert variant="destructive" role="status" data-slot="loud-skips">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Some scenarios were not run</AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-1">
          {tallies.map(({ reason, count }) => {
            const text = describeSkipReason(reason);
            return (
              <li key={reason} data-skip-reason={reason}>
                <span className="font-semibold">
                  {text.label}: {pluralize(count, "scenario")}.
                </span>{" "}
                {text.explanation}
              </li>
            );
          })}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function ScenarioListBody({ runId }: { runId: string }) {
  const { run } = useRunStreamState();
  const { values, setFilters, resetFilters, activeCount } = useUrlFilters(runScenarioFiltersCodec);
  const query = useInfiniteQuery(runScenariosQuery(runId, toApiFilters(values)));
  const facets = useQuery(runScenarioFacetsQuery(runId, run?.counters.scenarios_total ?? 0));

  const fields: readonly FilterField<FilterKey>[] = [
    {
      type: "multi",
      key: "status",
      label: "Status",
      options: filterOptions(RUN_SCENARIO_STATUSES, RUN_SCENARIO_STATUS_LABELS),
    },
    {
      type: "multi",
      key: "verdict",
      label: "Verdict",
      options: filterOptions(VERDICT_STATUSES, VERDICT_LABELS),
    },
    {
      type: "multi",
      key: "family",
      label: "Family",
      options: textFilterOptions(facets.data?.families, values.family),
    },
    {
      type: "multi",
      key: "role",
      label: "Role",
      options: textFilterOptions(facets.data?.roles, values.role),
    },
  ];

  const items = query.data?.items;
  const preparing = run !== undefined && PREPARING_STATUSES.includes(run.status);

  function renderContent() {
    if (query.isPending) {
      return <ScenarioListSkeleton />;
    }
    if (items === undefined) {
      return (
        <ErrorState
          title="Could not load the scenarios"
          description={describeApiError(query.error)}
          requestId={readRequestId(query.error)}
          onRetry={() => void query.refetch()}
          className="py-8"
        />
      );
    }
    if (items.length === 0) {
      return activeCount > 0 ? (
        <EmptyState
          title="No scenarios match"
          description="Change or clear the filters to see more scenarios."
          icon={SearchX}
          className="py-8"
          action={
            <Button variant="outline" onClick={() => resetFilters()}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <EmptyState
          title="No scenarios yet"
          description={
            preparing
              ? "The run is still preparing. Its scenarios appear here once planning finishes."
              : "This run has no scenarios."
          }
          icon={ListChecks}
          className="py-8"
        />
      );
    }
    return (
      <>
        {query.isError ? (
          <ErrorState
            title="Could not refresh the scenarios"
            description={describeApiError(query.error)}
            requestId={readRequestId(query.error)}
            onRetry={() => void query.refetch()}
            className="py-4"
          />
        ) : null}
        <LoudSkipSummary items={items} />
        <ul aria-label="Run scenarios" className="flex flex-col gap-2">
          {items.map((scenario) => (
            <ScenarioRow key={scenario.id} runId={runId} scenario={scenario} />
          ))}
        </ul>
        <DataTableFooter
          noun="scenario"
          loadedCount={query.data?.loadedCount ?? 0}
          total={query.data?.total}
          hasNextPage={query.hasNextPage}
          isFetchingNextPage={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={query.isFetching && !query.isPending}>
      <FilterBar
        label="Filter scenarios"
        fields={fields}
        values={values}
        onChange={(patch) => setFilters(patch)}
        onReset={() => resetFilters()}
        activeCount={activeCount}
      />
      {renderContent()}
    </div>
  );
}

export type ScenarioListProps = { runId: string };

export function ScenarioList({ runId }: ScenarioListProps) {
  const headingId = useId();
  const { run } = useRunStreamState();
  const uncertain = run?.counters.uncertain ?? 0;

  return (
    <section
      aria-labelledby={headingId}
      data-slot="scenario-list"
      data-run-id={runId}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          Scenarios
        </h2>
        {uncertain > 0 ? (
          <StatusBadge
            tone="verdict-uncertain"
            label={`${uncertain} uncertain`}
            icon={CircleHelp}
            data-slot="uncertain-count"
          />
        ) : null}
      </div>
      <Suspense fallback={<ScenarioListSkeleton />}>
        <ScenarioListBody runId={runId} />
      </Suspense>
    </section>
  );
}
