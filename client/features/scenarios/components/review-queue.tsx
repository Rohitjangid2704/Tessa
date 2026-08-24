"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { CircleCheck, RefreshCw, SearchX, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { DataTableFooter } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { HotkeyHint } from "@/components/hotkey-hint";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { filterOptions } from "@/features/runs/labels";
import { TargetFilterSelect } from "@/features/targets/components/target-filter-select";
import { describeApiError } from "@/lib/api/errors";
import type { ReviewDecision, ScenarioSummary } from "@/lib/api/types";
import { useCan } from "@/lib/auth/can";
import { coverageRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import { SCENARIO_ORIGIN_LABELS, SCENARIO_ORIGINS } from "../labels";
import { reviewQueueFilters, scenariosListQuery } from "../queries";
import { REVIEW_HOTKEYS, useReviewShortcuts, type ReviewShortcut } from "../review-shortcuts";
import { reviewFiltersCodec } from "../schemas";
import { isReviewConflict, useReviewScenario } from "../use-review-scenario";
import { RejectDialog } from "./reject-dialog";
import { ReviewDetail } from "./review-detail";

const FILTER_FIELDS: readonly FilterField<"origin">[] = [
  {
    type: "multi",
    key: "origin",
    label: "Origin",
    options: filterOptions(SCENARIO_ORIGINS, SCENARIO_ORIGIN_LABELS),
  },
];

const SKELETON_ROWS = 5;

function warningCount(summary: ScenarioSummary): number {
  return summary.validation.warnings.length;
}

type ReviewListProps = {
  items: readonly ScenarioSummary[];
  selectedId: string | undefined;
  onSelect: (scenarioId: string) => void;
};

function ReviewList({ items, selectedId, onSelect }: ReviewListProps) {
  const listRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <ol ref={listRef} aria-label="Scenarios waiting for review" className="flex flex-col gap-1">
      {items.map((item) => {
        const selected = item.id === selectedId;
        const warnings = warningCount(item);
        return (
          <li key={item.id}>
            <button
              type="button"
              data-scenario-id={item.id}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(item.id)}
              className={cn(
                "flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                selected ? "border-foreground bg-muted" : "border-transparent hover:bg-muted/60",
              )}
            >
              <span className="font-medium wrap-break-word">{item.title}</span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{SCENARIO_ORIGIN_LABELS[item.origin]}</Badge>
                <code className="font-mono">{item.family}</code>
                {warnings > 0 ? (
                  <span>
                    {warnings} {warnings === 1 ? "warning" : "warnings"}
                  </span>
                ) : null}
                <DateTime value={item.created_at} />
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function ReviewListSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-2">
      <span className="sr-only">Loading the review queue</span>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  );
}

export function ReviewQueue() {
  const hydrated = useHydrated();
  const canReview = useCan("scenarios.review");
  const { values, setFilters, resetFilters, activeCount: urlKeyCount } = useUrlFilters(
    reviewFiltersCodec,
  );
  const activeCount = urlKeyCount - (values.scenario === undefined ? 0 : 1);
  const query = useInfiniteQuery(
    scenariosListQuery(reviewQueueFilters(values.target_id, values.origin, values.replay_id)),
  );
  const review = useReviewScenario();
  const [rejecting, setRejecting] = useState<ScenarioSummary | null>(null);
  const [conflictTitle, setConflictTitle] = useState<string | null>(null);

  const items = hydrated
    ? (query.data?.items ?? []).filter((item) => item.status === "in_review")
    : [];
  const selected = items.find((item) => item.id === values.scenario) ?? items[0];
  const selectedIndex = selected === undefined ? -1 : items.indexOf(selected);
  const pendingDecision: ReviewDecision | null = review.isPending
    ? (review.variables?.decision ?? null)
    : null;
  const decisionError =
    review.isError &&
    !isReviewConflict(review.error) &&
    review.variables?.scenarioId === selected?.id
      ? review.error
      : null;

  function select(scenarioId: string | undefined): void {
    setFilters({ scenario: scenarioId });
  }

  function decide(item: ScenarioSummary, decision: ReviewDecision, note?: string): void {
    if (!canReview || review.isPending) {
      return;
    }
    const index = items.indexOf(item);
    const neighbour = items[index + 1] ?? items[index - 1];
    setConflictTitle(null);
    review.mutate(
      { scenarioId: item.id, decision, note },
      {
        onSuccess: () => {
          setRejecting(null);
          select(neighbour?.id);
          toast.success(
            decision === "accept" ? `Accepted "${item.title}"` : `Rejected "${item.title}"`,
          );
        },
        onError: (error) => {
          if (isReviewConflict(error)) {
            setRejecting(null);
            setConflictTitle(item.title);
          }
        },
      },
    );
  }

  function openReject(item: ScenarioSummary): void {
    review.reset();
    setRejecting(item);
  }

  function handleShortcut(shortcut: ReviewShortcut): void {
    if (shortcut === "next") {
      select(items[selectedIndex + 1]?.id ?? selected?.id);
      return;
    }
    if (shortcut === "previous") {
      select(items[selectedIndex - 1]?.id ?? selected?.id);
      return;
    }
    if (selected === undefined || !canReview || review.isPending) {
      return;
    }
    if (shortcut === "accept") {
      decide(selected, "accept");
    } else {
      openReject(selected);
    }
  }

  useReviewShortcuts(handleShortcut, hydrated && rejecting === null);

  let body: ReactNode;
  if (!hydrated || query.isPending) {
    body = <ReviewListSkeleton />;
  } else if (query.isError && query.data === undefined) {
    body = (
      <ErrorState
        title="Could not load the review queue"
        description={describeApiError(query.error)}
        requestId={readRequestId(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (items.length === 0 && !query.hasNextPage) {
    body =
      activeCount > 0 ? (
        <EmptyState
          title="Nothing to review with these filters"
          description="Clear the filters to see every scenario that waits for review."
          icon={SearchX}
          action={
            <Button variant="outline" onClick={() => resetFilters()}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <EmptyState
          title="Nothing to review"
          description="Generated and authored scenarios wait here until a person accepts or rejects them. Generate some from the coverage map, or upload a bundle with authored scenarios."
          icon={CircleCheck}
          action={
            <Button asChild variant="outline">
              <Link href={coverageRoutes.map(values.target_id)}>Open the coverage map</Link>
            </Button>
          }
        />
      );
  } else {
    body = (
      <div className="grid gap-6 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
        <aside aria-label="Review queue" className="flex min-w-0 flex-col gap-3">
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {items.length} {items.length === 1 ? "scenario waits" : "scenarios wait"} for review
          </p>
          <ReviewList items={items} selectedId={selected?.id} onSelect={select} />
          <DataTableFooter
            noun="scenario"
            loadedCount={items.length}
            total={query.data?.total}
            hasNextPage={query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
        </aside>
        <div className="min-w-0">
          {selected === undefined ? null : (
            <ReviewDetail
              key={selected.id}
              summary={selected}
              canReview={canReview}
              pendingDecision={pendingDecision}
              error={decisionError}
              onAccept={() => decide(selected, "accept")}
              onReject={() => openReject(selected)}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div data-slot="review-queue" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FilterBar
          label="Filter the review queue"
          fields={FILTER_FIELDS}
          values={values}
          onChange={(patch) => setFilters({ ...patch, scenario: undefined })}
          onReset={() => resetFilters()}
          activeCount={activeCount}
          className="min-w-0 flex-1"
        >
          <TargetFilterSelect
            value={values.target_id}
            onChange={(targetId) => setFilters({ target_id: targetId, scenario: undefined })}
          />
        </FilterBar>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!hydrated || query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw aria-hidden="true" data-icon="inline-start" />
            Refresh
          </Button>
          <HotkeyHint
            hotkeys={REVIEW_HOTKEYS}
            title="Review queue shortcuts"
            enabled={rejecting === null}
          />
        </div>
      </div>
      {values.replay_id === undefined ? null : (
        <p
          data-slot="replay-filter"
          className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
        >
          Showing only the cases created from replay{" "}
          <code className="font-mono text-xs">{values.replay_id.slice(0, 8)}</code>.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setFilters({ replay_id: undefined, scenario: undefined })}
          >
            Show every case
          </Button>
        </p>
      )}
      {conflictTitle === null ? null : (
        <Alert role="alert" data-slot="review-conflict">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>That scenario changed while you were looking at it</AlertTitle>
          <AlertDescription>
            {`"${conflictTitle}" was already reviewed or edited by someone else. The queue was refreshed, nothing was changed by your decision.`}
          </AlertDescription>
        </Alert>
      )}
      {body}
      <RejectDialog
        open={rejecting !== null}
        scenarioTitle={rejecting?.title ?? ""}
        pending={review.isPending && review.variables?.decision === "reject"}
        error={review.isError && !isReviewConflict(review.error) ? review.error : null}
        onOpenChange={(open) => {
          if (!open) {
            setRejecting(null);
            review.reset();
          }
        }}
        onConfirm={(note) => {
          if (rejecting !== null) {
            decide(rejecting, "reject", note);
          }
        }}
      />
    </div>
  );
}
