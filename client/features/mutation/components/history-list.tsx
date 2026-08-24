"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { createDataTableColumnHelper, DataTable, DataTableFooter } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { EmptyState } from "@/components/states/empty-state";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import { Button } from "@/components/ui/button";
import { runRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { cn } from "@/lib/utils";
import { describeOutcomeCounts, formatPower } from "../model";
import { mutationRunsQuery } from "../queries";
import type { Mutant, MutationRun } from "../types";

export type HistoryListProps = {
  targetId: string;
  mutants: readonly Mutant[];
  className?: string;
};

const helper = createDataTableColumnHelper<MutationRun>();

function historyColumns(names: ReadonlyMap<string, string>) {
  return [
    helper.display({
      id: "mutant",
      header: "Mutant",
      enableSorting: false,
      cell: (info) => (
        <span className="font-mono text-sm wrap-anywhere">
          {names.get(info.row.original.mutant_id) ?? "A deleted mutant"}
        </span>
      ),
    }),
    helper.display({
      id: "started_at",
      header: "Started",
      enableSorting: false,
      cell: (info) => <DateTime value={info.row.original.started_at} className="text-xs" />,
    }),
    helper.display({
      id: "status",
      header: "Status",
      enableSorting: false,
      cell: (info) => <RunStatusBadge status={info.row.original.status} />,
    }),
    helper.display({
      id: "result",
      header: "Result",
      enableSorting: false,
      cell: (info) => (
        <span className="flex flex-col text-sm">
          <span>{describeOutcomeCounts(info.row.original.outcomes)}</span>
          <span className="text-xs text-muted-foreground">{formatPower(info.row.original.power)}</span>
        </span>
      ),
    }),
    helper.display({
      id: "open",
      header: () => <span className="sr-only">Open</span>,
      enableSorting: false,
      meta: { align: "end" },
      cell: (info) => {
        const name = names.get(info.row.original.mutant_id) ?? "a deleted mutant";
        return (
          <Button asChild variant="ghost" size="sm">
            <Link href={runRoutes.detail(info.row.original.run_id)}>
              Open the run
              <span className="sr-only"> for {name}</span>
            </Link>
          </Button>
        );
      },
    }),
  ];
}

export function HistoryList({ targetId, mutants, className }: HistoryListProps) {
  const headingId = useId();
  const hydrated = useHydrated();
  const query = useInfiniteQuery(mutationRunsQuery(targetId));
  const names = new Map(mutants.map((mutant) => [mutant.id, mutant.name]));

  return (
    <section
      aria-labelledby={headingId}
      data-slot="history-list"
      className={cn("flex flex-col gap-3", className)}
    >
      <h2 id={headingId} className="text-base font-semibold">
        Run history
      </h2>
      <DataTable<MutationRun>
        label="Mutation runs"
        columns={historyColumns(names)}
        data={hydrated ? query.data?.items : undefined}
        getRowId={(row) => row.id}
        isLoading={!hydrated || query.isPending}
        isFetching={hydrated && query.isFetching}
        error={hydrated ? query.error : null}
        onRetry={() => void query.refetch()}
        emptyState={
          <EmptyState
            icon={History}
            title="No mutation run yet"
            description="Every run of a mutant is listed here, newest first."
            className="py-10"
          />
        }
        getRowProps={(row) => ({ "data-mutation-run-id": row.id, "data-status": row.status })}
        footer={
          <DataTableFooter
            noun="run"
            loadedCount={hydrated ? (query.data?.loadedCount ?? 0) : 0}
            total={query.data?.total}
            hasNextPage={hydrated && query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
        }
      />
    </section>
  );
}
