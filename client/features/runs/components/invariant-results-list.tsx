"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ListChecks } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { DataTableFooter } from "@/components/data-table";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { TierBadge } from "@/components/status/tier-badge";
import type { VerdictStatus } from "@/components/status/status-types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { InvariantStatusBadge } from "@/features/invariants/components/invariant-status-badge";
import { describeApiError } from "@/lib/api/errors";
import type { InvariantInfo, InvariantResult } from "@/lib/api/types";
import { runRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { formatConfidence } from "../format";
import { runInvariantsQuery, type InvariantResultFilters } from "../stats-queries";
import { SkipReasonBadge } from "./skip-reason-badge";

export const RESULT_ROW_ESTIMATE_PX = 84;
export const RESULT_LIST_HEIGHT_PX = 360;
export const RESULT_OVERSCAN_ROWS = 6;
export const LONG_MESSAGE_CHARS = 140;

const INITIAL_RECT = { width: 640, height: RESULT_LIST_HEIGHT_PX };

export type InvariantResultsListProps = {
  runId: string;
  invariantId: string | null;
  status: VerdictStatus | null;
  catalog: ReadonlyMap<string, InvariantInfo>;
};

type ResultRowProps = {
  runId: string;
  result: InvariantResult;
  title: string;
  index: number;
  position: number;
  total: number;
  offset: number;
  measureRef: (element: HTMLLIElement | null) => void;
};

function attemptLabel(attempt: number | null): string {
  return attempt === null ? "Run level" : `Attempt ${attempt + 1}`;
}

function ResultRow({
  runId,
  result,
  title,
  index,
  position,
  total,
  offset,
  measureRef,
}: ResultRowProps) {
  const [expanded, setExpanded] = useState(false);
  const confidence = formatConfidence(result.confidence);
  const isLong = result.message.length > LONG_MESSAGE_CHARS;
  return (
    <li
      ref={measureRef}
      data-slot="invariant-result"
      data-index={index}
      data-status={result.status}
      data-invariant-id={result.invariant_id}
      aria-posinset={position}
      aria-setsize={total}
      className="absolute top-0 left-0 w-full border-b"
      style={{ transform: `translateY(${offset}px)` }}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2">
        <InvariantStatusBadge status={result.status} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm wrap-break-word">
            <span className="font-medium">{title}</span>{" "}
            <code className="font-mono text-xs text-muted-foreground">{result.invariant_id}</code>
          </p>
          {result.message === "" ? null : (
            <div className="flex flex-col items-start gap-1">
              <p
                className={cn(
                  "text-sm wrap-break-word text-muted-foreground",
                  !expanded && "line-clamp-2",
                )}
              >
                {result.message}
              </p>
              {isLong ? (
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((current) => !current)}
                  className="h-auto px-0"
                >
                  {expanded ? "Show less" : "Show more"}
                </Button>
              ) : null}
            </div>
          )}
          {result.status === "skipped" && result.skip_reason !== null ? (
            <div data-slot="invariant-skip-reason">
              <SkipReasonBadge reason={result.skip_reason} />
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
          <span>{attemptLabel(result.attempt)}</span>
          <span className="flex items-center gap-1.5">
            <TierBadge tier={result.tier} />
            {confidence === null ? null : (
              <span className="tabular-nums">
                <span className="sr-only">Confidence </span>
                {confidence}
              </span>
            )}
          </span>
          {result.step_id === null ? null : (
            <Link
              href={runRoutes.step(runId, result.step_id)}
              scroll={false}
              className="font-medium text-foreground underline underline-offset-4"
            >
              View step
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

export function InvariantResultsList({
  runId,
  invariantId,
  status,
  catalog,
}: InvariantResultsListProps) {
  "use no memo";

  const filters: InvariantResultFilters = {
    ...(invariantId === null ? {} : { invariant_id: [invariantId] }),
    ...(status === null ? {} : { status: [status] }),
  };
  const query = useInfiniteQuery(runInvariantsQuery(runId, filters));
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = query.data?.items ?? [];

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLLIElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => RESULT_ROW_ESTIMATE_PX,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: RESULT_OVERSCAN_ROWS,
    initialRect: INITIAL_RECT,
  });

  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        <span className="sr-only">Loading invariant results</span>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title="Could not load invariant results"
        description={describeApiError(query.error)}
        requestId={readRequestId(query.error)}
        onRetry={() => void query.refetch()}
        className="py-8"
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No results match"
        description="No invariant results fit this filter yet. Results appear here as scenarios finish."
        icon={ListChecks}
        className="py-8"
      />
    );
  }

  return (
    <div data-slot="invariant-results" className="flex flex-col gap-2">
      <div
        ref={scrollRef}
        role="group"
        aria-label="Invariant results"
        tabIndex={0}
        style={{ height: RESULT_LIST_HEIGHT_PX }}
        className="relative overflow-auto rounded-lg border bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ul
          style={{ height: virtualizer.getTotalSize() }}
          className="relative m-0 w-full list-none p-0"
        >
          {virtualizer.getVirtualItems().map((item) => {
            const result = rows[item.index];
            if (result === undefined) {
              return null;
            }
            return (
              <ResultRow
                key={result.id}
                runId={runId}
                result={result}
                title={catalog.get(result.invariant_id)?.title ?? result.invariant_id}
                index={item.index}
                position={item.index + 1}
                total={rows.length}
                offset={item.start}
                measureRef={virtualizer.measureElement}
              />
            );
          })}
        </ul>
      </div>
      <DataTableFooter
        noun="result"
        loadedCount={query.data?.loadedCount ?? 0}
        total={query.data?.total}
        hasNextPage={query.hasNextPage}
        isFetchingNextPage={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </div>
  );
}
