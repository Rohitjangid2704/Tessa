"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { DataTableFooter } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { pluralize } from "@/features/bundles/format";
import { describeApiError } from "@/lib/api/errors";
import { oracleResultsQuery } from "../queries";
import type { OracleResult } from "../types";
import { ResultStatusBadge } from "./oracle-badges";

export interface ResultHistoryProps {
  templateId: string;
  selectedResultId: string | null;
  onSelect: (resultId: string) => void;
}

function describeOutcome(result: OracleResult): string {
  if (result.status === "ok") {
    return result.rows_truncated
      ? `${pluralize(result.rows.length, "row")}, cut`
      : pluralize(result.rows.length, "row");
  }
  return result.status === "error" ? (result.error ?? "failed") : "running";
}

export function ResultHistory({ templateId, selectedResultId, onSelect }: ResultHistoryProps) {
  const query = useInfiniteQuery(oracleResultsQuery(templateId));

  if (query.isPending) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading the history</span>
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        <span>
          Could not load the history. {describeApiError(query.error)}
          {readRequestId(query.error) === null ? "" : ` Request ID: ${readRequestId(query.error)}`}
        </span>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const { items, total, loadedCount } = query.data;
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">This template has not been run yet.</p>;
  }

  return (
    <div data-slot="result-history" className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y rounded-lg border">
        {items.map((result) => {
          const selected = result.id === selectedResultId;
          return (
            <li
              key={result.id}
              data-result-id={result.id}
              aria-current={selected ? "true" : undefined}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm aria-current:bg-muted"
            >
              <ResultStatusBadge status={result.status} />
              <span className="min-w-0 flex-1 truncate">
                <DateTime value={result.executed_at} fallback="Running now" />
                <span className="text-muted-foreground"> · {describeOutcome(result)}</span>
              </span>
              <Button
                type="button"
                variant={selected ? "secondary" : "outline"}
                size="sm"
                aria-pressed={selected}
                onClick={() => onSelect(result.id)}
              >
                {selected ? "Shown above" : "Show"}
                <span className="sr-only">
                  {" "}
                  result from <DateTime value={result.executed_at} fallback="a running query" />
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
      <DataTableFooter
        noun="result"
        loadedCount={loadedCount}
        total={total}
        hasNextPage={query.hasNextPage}
        isFetchingNextPage={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </div>
  );
}
