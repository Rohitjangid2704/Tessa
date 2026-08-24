"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { DataTableFooter } from "@/components/data-table";
import { EmptyState } from "@/components/states/empty-state";
import type { RunKind } from "@/lib/api/types";
import { useHydrated } from "@/lib/use-hydrated";
import { runsListQuery, type RunListFilters } from "../queries";
import { RunsFeed } from "./runs-feed";
import { RunsTable } from "./runs-table";

export type RunKindListProps = {
  kind: RunKind;
  targetId: string | null;
  heading: string;
  noun: string;
  emptyDescription: string;
  action?: ReactNode;
};

export function RunKindList({
  kind,
  targetId,
  heading,
  noun,
  emptyDescription,
  action,
}: RunKindListProps) {
  const headingId = useId();
  const hydrated = useHydrated();
  const [feedGeneration, setFeedGeneration] = useState(0);
  const filters: RunListFilters = {
    ...(targetId === null ? {} : { target_id: targetId }),
    kind: [kind],
  };
  const query = useInfiniteQuery(runsListQuery(filters));

  return (
    <section
      aria-labelledby={headingId}
      data-slot="run-kind-list"
      data-kind={kind}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="text-base font-semibold">
          {heading}
        </h2>
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
        emptyState={
          <EmptyState
            icon={Play}
            title={`No ${noun}s yet`}
            description={emptyDescription}
            action={action}
          />
        }
        footer={
          <DataTableFooter
            noun={noun}
            loadedCount={hydrated ? (query.data?.loadedCount ?? 0) : 0}
            total={hydrated ? query.data?.total : undefined}
            hasNextPage={hydrated && query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
        }
      />
    </section>
  );
}
