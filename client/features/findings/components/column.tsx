"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useId } from "react";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { FindingStatusBadge } from "@/components/status/finding-status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import type { FindingStatus, FindingSummary } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { FINDING_STATUS_LABELS } from "../detail-schemas";
import { pluralize } from "../labels";
import type { ColumnData } from "../use-board-columns";
import { FindingCard } from "./finding-card";

const ACCENT_CLASSES: Record<FindingStatus, string> = {
  new: "border-t-finding-new-fg",
  triaged: "border-t-finding-triaged-fg",
  in_fix: "border-t-finding-in-fix-fg",
  verifying: "border-t-finding-verifying-fg",
  resolved: "border-t-finding-resolved-fg",
  known_gap: "border-t-finding-known-gap-fg",
  dismissed: "border-t-finding-dismissed-fg",
};

const SKELETON_CARDS = 3;

export interface ColumnProps {
  status: FindingStatus;
  column: ColumnData;
  cards: readonly FindingSummary[];
  total: number | null;
  collapsed: boolean;
  filtered: boolean;
  movingIds: ReadonlySet<string>;
  onToggle: (status: FindingStatus) => void;
  hrefFor: (findingId: string) => string;
  onOpen: (findingId: string) => void;
  onMove: (finding: FindingSummary, to: FindingStatus) => void;
}

function describeFooter(shown: number, total: number | null): string {
  if (total === null) {
    return `Showing ${shown}`;
  }
  return `Showing ${shown} of ${total}`;
}

export function ColumnSkeletonCards() {
  return (
    <div className="flex flex-col gap-2 p-2" aria-hidden="true">
      {Array.from({ length: SKELETON_CARDS }, (_, index) => (
        <Skeleton key={index} className="h-24 w-full rounded-lg" />
      ))}
    </div>
  );
}

export function Column({
  status,
  column,
  cards,
  total,
  collapsed,
  filtered,
  movingIds,
  onToggle,
  hrefFor,
  onOpen,
  onMove,
}: ColumnProps) {
  const headingId = useId();
  const bodyId = useId();
  const label = FINDING_STATUS_LABELS[status];
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const failed = column.error !== null && column.error !== undefined;
  const countText = total === null ? null : String(total);

  return (
    <section
      aria-labelledby={headingId}
      data-slot="finding-column"
      data-status={status}
      data-collapsed={collapsed}
      className={cn(
        "flex shrink-0 flex-col self-start rounded-xl border border-t-2 bg-muted/30",
        ACCENT_CLASSES[status],
        collapsed ? "w-60" : "w-80",
      )}
    >
      <header className="flex items-center justify-between gap-2 p-3">
        <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold">
          <FindingStatusBadge status={status} />
          {countText === null ? null : (
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              <span aria-hidden="true">{countText}</span>
              <span className="sr-only">
                {countText} {pluralize(total ?? 0, "finding")}
              </span>
            </span>
          )}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={`${collapsed ? "Expand" : "Collapse"} the ${label} column`}
          onClick={() => onToggle(status)}
        >
          <Chevron aria-hidden="true" />
        </Button>
      </header>
      <div id={bodyId} hidden={collapsed} aria-busy={column.isPending || column.isFetching}>
        {collapsed ? null : (
          <>
            {column.isPending && cards.length === 0 ? (
              <>
                <span role="status" className="sr-only">
                  Loading {label} findings
                </span>
                <ColumnSkeletonCards />
              </>
            ) : null}
            {!column.isPending && failed && cards.length === 0 ? (
              <ErrorState
                title={`Could not load ${label}`}
                description={describeApiError(column.error)}
                requestId={readRequestId(column.error)}
                onRetry={column.retry}
                className="gap-2 rounded-t-none border-0 px-3 py-6"
              />
            ) : null}
            {!column.isPending && !failed && cards.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {filtered ? "No findings match the filters" : `Nothing in ${label}`}
              </p>
            ) : null}
            {cards.length > 0 ? (
              <ul aria-label={`${label} findings`} className="flex flex-col gap-2 p-2">
                {cards.map((card) => (
                  <FindingCard
                    key={card.id}
                    finding={card}
                    href={hrefFor(card.id)}
                    moving={movingIds.has(card.id)}
                    onOpen={onOpen}
                    onMove={onMove}
                  />
                ))}
              </ul>
            ) : null}
            {failed && cards.length > 0 ? (
              <p role="alert" className="px-3 pb-2 text-xs text-destructive">
                {describeApiError(column.error)}
                <Button type="button" variant="link" size="xs" onClick={column.retry}>
                  Retry
                </Button>
              </p>
            ) : null}
            {cards.length > 0 || column.hasNextPage ? (
              <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs">
                <p className="text-muted-foreground">{describeFooter(cards.length, total)}</p>
                {column.hasNextPage ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={column.isFetchingNextPage}
                    aria-busy={column.isFetchingNextPage}
                    onClick={column.loadMore}
                  >
                    {column.isFetchingNextPage ? "Loading more" : "Load more"}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
