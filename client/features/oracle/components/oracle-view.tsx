"use client";

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { MousePointerClick } from "lucide-react";
import Link from "next/link";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CurrentTargetGate } from "@/features/targets/current-target-gate";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { targetRoutes } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import { oracleTemplatesQuery } from "../queries";
import {
  APPROVAL_LABELS,
  ORACLE_APPROVALS,
  oracleFiltersCodec,
  oracleSelectionCodec,
  readId,
} from "../schemas";
import { NoTemplatesState } from "./no-templates-state";
import { TemplateDetail } from "./template-detail";
import { TemplateList } from "./template-list";

type FilterKey = "feature_id" | "approval";

const FILTER_FIELDS: readonly FilterField<FilterKey>[] = [
  {
    type: "text",
    key: "feature_id",
    label: "Feature",
    placeholder: "Exact feature id",
  },
  {
    type: "multi",
    key: "approval",
    label: "Approval",
    options: ORACLE_APPROVALS.map((approval) => ({
      value: approval,
      label: APPROVAL_LABELS[approval],
    })),
  },
];

function WorkspaceSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the oracle templates</span>
      <Skeleton className="h-8 w-full max-w-xl" />
      <div className="grid gap-6 lg:grid-cols-[minmax(18rem,24rem)_1fr]">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}

export interface OracleWorkspaceProps {
  targetId: string;
}

export function OracleWorkspace({ targetId }: OracleWorkspaceProps) {
  const hydrated = useHydrated();
  const filters = useUrlFilters(oracleFiltersCodec);
  const selection = useUrlFilters(oracleSelectionCodec);
  const query = useInfiniteQuery({
    ...oracleTemplatesQuery({
      targetId,
      featureId: filters.values.feature_id,
      approval: filters.values.approval,
    }),
    placeholderData: keepPreviousData,
  });
  const templateId = readId(selection.values.template_id);
  const resultId = readId(selection.values.result_id);

  if (!hydrated || query.isPending) {
    return <WorkspaceSkeleton />;
  }

  if (query.isError) {
    const notFound = isApiError(query.error) && query.error.status === 404;
    return (
      <ErrorState
        title={notFound ? "Target not found" : "Could not load the oracle templates"}
        description={
          notFound
            ? "This target does not exist. Pick another target from the targets list."
            : describeApiError(query.error)
        }
        requestId={readRequestId(query.error)}
        onRetry={notFound ? undefined : () => void query.refetch()}
        action={
          notFound ? (
            <Button asChild variant="outline">
              <Link href={targetRoutes.list()}>Back to targets</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }

  const { items, total, loadedCount } = query.data;
  const filtered = filters.activeCount > 0;

  if (items.length === 0 && !filtered) {
    return <NoTemplatesState targetId={targetId} />;
  }

  function selectTemplate(nextId: string): void {
    selection.setFilters({ template_id: nextId, result_id: undefined }, { history: "push" });
  }

  function selectResult(nextId: string): void {
    selection.setFilters({ result_id: nextId }, { history: "replace" });
  }

  function clearSelection(): void {
    selection.setFilters({ template_id: undefined, result_id: undefined }, { history: "push" });
  }

  return (
    <div
      data-slot="oracle-workspace"
      aria-busy={query.isPlaceholderData}
      className="flex flex-col gap-6"
    >
      <FilterBar
        label="Filter templates"
        fields={FILTER_FIELDS}
        values={filters.values}
        onChange={(patch) => filters.setFilters(patch)}
        onReset={() => filters.resetFilters()}
        activeCount={filters.activeCount}
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
        <TemplateList
          templates={items}
          selectedId={templateId}
          onSelect={selectTemplate}
          filtered={filtered}
          onClearFilters={() => filters.resetFilters()}
          loadedCount={loadedCount}
          total={total}
          hasNextPage={query.hasNextPage}
          isFetchingNextPage={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
        {templateId === null ? (
          <EmptyState
            title="Select a template"
            description="Pick a template to read its query, run it with parameters, review the rows and approve it."
            icon={MousePointerClick}
          />
        ) : (
          <TemplateDetail
            key={templateId}
            templateId={templateId}
            resultId={resultId}
            onResultChange={selectResult}
            onClose={clearSelection}
          />
        )}
      </div>
    </div>
  );
}

export function OracleView() {
  return (
    <CurrentTargetGate
      title="Choose a target"
      description="Oracle templates are the read-only queries of one target's latest valid bundle. Pick a target to see them."
    >
      {(targetId) => <OracleWorkspace key={targetId} targetId={targetId} />}
    </CurrentTargetGate>
  );
}
