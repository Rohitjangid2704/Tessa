"use client";

import { Bug, SearchX } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { FindingStatus, FindingSummary } from "@/lib/api/types";
import { useCanDo } from "@/lib/auth/can";
import { findingRoutes, routes, withQuery } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { flattenColumns, groupByStatus } from "../board-model";
import { FINDING_STATUSES } from "../detail-schemas";
import { openFindingSheet, readOpenFindingId } from "../detail-url";
import { COLLAPSED_BY_DEFAULT } from "../labels";
import { findingFiltersCodec, toBoardFilters } from "../schemas";
import { useBoardColumns } from "../use-board-columns";
import { BoardFeed } from "./board-feed";
import { Column, ColumnSkeletonCards } from "./column";
import { FindingFilterBar } from "./filter-bar";
import { FindingSheet } from "./finding-sheet";
import { KnownGapDialog } from "./known-gap-dialog";
import { useKnownGapMove } from "./use-known-gap-move";
import { useMoveFinding } from "./use-move-finding";

export interface BoardProps {
  targetId: string;
}

function BoardSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex gap-3 overflow-x-auto pb-4">
      <span className="sr-only">Loading findings</span>
      {FINDING_STATUSES.map((status) => (
        <div
          key={status}
          data-slot="finding-column-skeleton"
          className="flex w-80 shrink-0 flex-col self-start rounded-xl border bg-muted/30"
        >
          <div className="flex items-center justify-between p-3">
            <Skeleton className="h-5 w-24 rounded-4xl" />
            <Skeleton className="size-7 rounded-lg" />
          </div>
          <ColumnSkeletonCards />
        </div>
      ))}
    </div>
  );
}

export function Board({ targetId }: BoardProps) {
  const searchParams = useSearchParams();
  const updateAccess = useCanDo("findings.update");
  const { values, setFilters, resetFilters, activeCount } = useUrlFilters(findingFiltersCodec);
  const [feedGeneration, setFeedGeneration] = useState(0);
  const [toggled, setToggled] = useState<readonly FindingStatus[]>([]);

  const filters = toBoardFilters(values);
  const columns = useBoardColumns(targetId, filters);
  const moves = useMoveFinding(flattenColumns(columns));
  const knownGap = useKnownGapMove(moves.move);
  const grouped = groupByStatus(moves.cards);

  const openId = readOpenFindingId(new URLSearchParams(searchParams.toString()));
  const visibleStatuses = FINDING_STATUSES.filter(
    (status) => values.status === undefined || values.status.includes(status),
  );
  const allPending = visibleStatuses.every((status) => columns[status].isPending);
  const anyPending = visibleStatuses.some((status) => columns[status].isPending);
  const anyError = visibleStatuses.some((status) => columns[status].error !== null);
  const visibleTotal = visibleStatuses.reduce((sum, status) => {
    const column = columns[status];
    return sum + (column.total ?? column.cards.length);
  }, 0);
  const boardEmpty = !anyPending && !anyError && visibleTotal === 0;

  function isCollapsed(status: FindingStatus): boolean {
    const byDefault = COLLAPSED_BY_DEFAULT.includes(status) && !values.status?.includes(status);
    return byDefault !== toggled.includes(status);
  }

  function toggleColumn(status: FindingStatus): void {
    setToggled((previous) =>
      previous.includes(status) ? previous.filter((item) => item !== status) : [...previous, status],
    );
  }

  function handleMove(finding: FindingSummary, to: FindingStatus): void {
    if (to === "known_gap") {
      knownGap.open(finding);
      return;
    }
    void moves.move(finding, to);
  }

  function adjustedTotal(status: FindingStatus): number | null {
    const { total } = columns[status];
    return total === null ? null : Math.max(0, total + moves.deltas[status]);
  }

  function renderBody() {
    if (allPending) {
      return <BoardSkeleton />;
    }
    if (boardEmpty && activeCount === 0) {
      return (
        <EmptyState
          title="No findings yet"
          description="Failed checks from your runs become findings you can triage here. Pick features in the catalog and run them to get started."
          icon={Bug}
          action={
            <Button asChild>
              <Link href={withQuery(routes.catalog, { target_id: targetId })}>Open the catalog</Link>
            </Button>
          }
        />
      );
    }
    if (boardEmpty) {
      return (
        <EmptyState
          title="No findings match"
          description="Change or clear the filters to see more findings. New findings that match appear here as runs finish."
          icon={SearchX}
          action={
            <Button variant="outline" onClick={() => resetFilters()}>
              Clear filters
            </Button>
          }
        />
      );
    }
    return (
      <div
        role="region"
        aria-label="Findings board"
        tabIndex={0}
        className="flex items-start gap-3 overflow-x-auto pb-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {visibleStatuses.map((status) => (
          <Column
            key={status}
            status={status}
            column={columns[status]}
            cards={grouped[status]}
            total={adjustedTotal(status)}
            collapsed={isCollapsed(status)}
            filtered={activeCount > 0}
            movingIds={moves.movingIds}
            onToggle={toggleColumn}
            hrefFor={(findingId) => findingRoutes.sheet(findingId, { target_id: targetId })}
            onOpen={openFindingSheet}
            onMove={handleMove}
          />
        ))}
      </div>
    );
  }

  return (
    <div data-slot="findings-board" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FindingFilterBar
          targetId={targetId}
          values={values}
          activeCount={activeCount}
          onChange={(patch) => setFilters(patch)}
          onReset={() => resetFilters()}
        />
        <BoardFeed
          key={feedGeneration}
          targetId={targetId}
          filters={filters}
          onRestart={() => setFeedGeneration((generation) => generation + 1)}
        />
      </div>
      {updateAccess.reason !== null ? (
        <p data-slot="read-only-note" className="text-sm text-muted-foreground">
          You can read the board. Moving findings between columns requires the member role.
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="sr-only">
        {moves.announcement}
      </p>
      {renderBody()}
      {openId === null ? null : <FindingSheet findingId={openId} />}
      <KnownGapDialog
        open={knownGap.target !== null}
        onOpenChange={(open) => {
          if (!open) {
            knownGap.close();
          }
        }}
        mode="move"
        initialReason={null}
        pending={knownGap.pending}
        error={knownGap.error}
        onSubmit={knownGap.submit}
      />
    </div>
  );
}
