"use client";

import { CheckCheck, Inbox, Keyboard, LoaderCircle, SearchX } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { describeApiError } from "@/lib/api/errors";
import { useCan, useCanDo } from "@/lib/auth/can";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import { isMachineValueVisible, useRevealMachineValue } from "../blind-mode";
import { queueFiltersCodec, type QueueFilters } from "../schemas";
import { useLabelQueue } from "../use-label-queue";
import { SHORTCUT_KEYS, useLabelShortcuts, type ShortcutAction } from "../use-label-shortcuts";
import { AnsweredNote, LabelCard, stepHref } from "./label-card";
import { LabelProgress } from "./label-progress";
import { QueueFiltersBar } from "./queue-filters";
import { ShortcutHelp } from "./shortcut-help";

export const VIEWER_CARD_REASON = "Labeling needs the member role.";

export const VIEWER_REASON =
  "You have the viewer role, so you can read the queue and the progress but not label. Ask a member or an admin to label.";

function QueueSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" className="flex max-w-3xl flex-col gap-3">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-6 w-72" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-9 w-80" />
    </div>
  );
}

interface ReviewSessionProps {
  filters: QueueFilters;
  activeCount: number;
  onClearFilters: () => void;
}

function ReviewSession({ filters, activeCount, onClearFilters }: ReviewSessionProps) {
  const { allowed: canLabel, isPending: rolePending } = useCanDo("labels.create");
  const canDelete = useCan("labels.delete");
  const isViewer = !rolePending && !canLabel;
  const [revealBeforeAnswer, setRevealBeforeAnswer] = useRevealMachineValue();
  const [helpOpen, setHelpOpen] = useState(false);
  const cardFrameRef = useRef<HTMLDivElement>(null);
  const revealId = useId();
  const queue = useLabelQueue(filters, {
    onRollback: () => {
      const frame = cardFrameRef.current;
      if (frame !== null && !frame.contains(document.activeElement)) {
        frame.focus({ preventScroll: true });
      }
    },
  });
  const { current, query } = queue;

  function handleShortcut(action: ShortcutAction): void {
    switch (action.kind) {
      case "answer":
        if (canLabel) {
          queue.answer(action.value);
        }
        return;
      case "skip":
        queue.skip();
        return;
      case "undo":
        if (canDelete) {
          queue.undo();
        }
        return;
      case "open":
        if (current !== null) {
          window.open(stepHref(current), "_blank", "noopener,noreferrer");
        }
        return;
      case "help":
        setHelpOpen(true);
        return;
    }
  }

  useLabelShortcuts(handleShortcut, !helpOpen);

  function renderBody(): ReactNode {
    if (query.isPending) {
      return <QueueSkeleton label="Loading the review queue" />;
    }
    if (query.isError && query.data === undefined) {
      return (
        <ErrorState
          title="Could not load the review queue"
          description={describeApiError(query.error)}
          requestId={readRequestId(query.error)}
          onRetry={() => void query.refetch()}
        />
      );
    }
    if (current === null) {
      if (query.isFetchNextPageError) {
        return (
          <ErrorState
            title="Could not load more cards"
            description={describeApiError(query.error)}
            requestId={readRequestId(query.error)}
            onRetry={() => void query.fetchNextPage()}
          />
        );
      }
      if (query.hasNextPage) {
        return <QueueSkeleton label="Loading more cards" />;
      }
      if (queue.answeredCount > 0) {
        return (
          <EmptyState
            icon={CheckCheck}
            title="You reached the end of the queue"
            description={`You labeled ${queue.answeredCount} ${queue.answeredCount === 1 ? "task" : "tasks"} in this session. New tasks appear here as runs are graded.`}
            action={
              <Button variant="outline" onClick={() => void query.refetch()}>
                Check for new tasks
              </Button>
            }
          />
        );
      }
      if (activeCount > 0) {
        return (
          <EmptyState
            icon={SearchX}
            title="No tasks match these filters"
            description="Change or clear the filters to see more tasks."
            action={
              <Button variant="outline" onClick={onClearFilters}>
                Clear filters
              </Button>
            }
          />
        );
      }
      return (
        <EmptyState
          icon={Inbox}
          title="Nothing to review"
          description="Uncertain, flagged, disagreeing and audited grades queue here so a person can settle them."
        />
      );
    }

    const machineVisible = isMachineValueVisible({
      reason: current.reason,
      answered: false,
      revealBeforeAnswer,
    });

    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground tabular-nums" data-slot="queue-count">
            {queue.remaining} left to review
            {queue.skippedCount > 0 ? `, ${queue.skippedCount} skipped` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id={revealId}
                checked={revealBeforeAnswer}
                onCheckedChange={setRevealBeforeAnswer}
              />
              <Label htmlFor={revealId} className="font-normal">
                Show machine value before I answer
              </Label>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-keyshortcuts={SHORTCUT_KEYS.help}
              onClick={() => setHelpOpen(true)}
            >
              <Keyboard aria-hidden="true" data-icon="inline-start" />
              Shortcuts
              <Kbd aria-hidden="true">{SHORTCUT_KEYS.help}</Kbd>
            </Button>
          </div>
        </div>
        {isViewer ? (
          <p
            data-slot="viewer-notice"
            className="max-w-3xl rounded-lg border bg-muted/40 px-3 py-2 text-sm"
          >
            {VIEWER_REASON}
          </p>
        ) : null}
        {queue.failure === null ? null : (
          <div
            role="alert"
            data-slot="queue-failure"
            className="flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 px-3 py-2 text-sm"
          >
            <div className="flex flex-col gap-0.5">
              <p>The card is back. Your last action was not saved: {queue.failure.message}</p>
              {queue.failure.requestId === null ? null : (
                <p className="font-mono text-xs text-muted-foreground">
                  Request ID: {queue.failure.requestId}
                </p>
              )}
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={queue.dismissFailure}>
              Dismiss
            </Button>
          </div>
        )}
        {queue.lastAnswered === null ? null : <AnsweredNote answered={queue.lastAnswered} />}
        <div
          ref={cardFrameRef}
          tabIndex={-1}
          aria-busy={queue.pending > 0}
          data-slot="card-frame"
          className="max-w-3xl rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <LabelCard
            task={current}
            machineVisible={machineVisible}
            canLabel={canLabel}
            readOnlyReason={isViewer ? VIEWER_CARD_REASON : undefined}
            canUndo={queue.canUndo && canDelete}
            onAnswer={queue.answer}
            onSkip={queue.skip}
            onUndo={queue.undo}
          />
        </div>
        {queue.pending > 0 ? (
          <p data-slot="saving" className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
            Saving {queue.pending} {queue.pending === 1 ? "label" : "labels"}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {renderBody()}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-slot="label-live-region"
        className="sr-only"
      >
        {queue.announcement}
      </p>
      <ShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </>
  );
}

export function LabelQueue() {
  const hydrated = useHydrated();
  const { values, setFilters, resetFilters, activeCount } = useUrlFilters(queueFiltersCodec);

  if (!hydrated) {
    return <QueueSkeleton label="Loading the review queue" />;
  }

  return (
    <div className="flex flex-col gap-6">
      <LabelProgress />
      <QueueFiltersBar
        values={values}
        onChange={(patch) => setFilters(patch)}
        onReset={() => resetFilters()}
        activeCount={activeCount}
      />
      <ReviewSession
        key={JSON.stringify(values)}
        filters={values}
        activeCount={activeCount}
        onClearFilters={() => resetFilters()}
      />
    </div>
  );
}
