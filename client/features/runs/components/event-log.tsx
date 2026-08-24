"use client";

import { ArrowDown, LoaderCircle } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useThrottledValue } from "@/lib/use-throttled-value";
import {
  buildLogRows,
  countFamilies,
  countRowsAfterSeq,
  type EventFamily,
} from "../event-log-model";
import { useRunEventsPerFrame } from "../use-run-events-per-frame";
import { useRunStreamHandle } from "../use-run-stream";
import { EventFilters } from "./event-filters";
import { EventList, type RestoreRequest } from "./event-list";

export const EVENT_LOG_ANNOUNCEMENT_INTERVAL_MS = 5000;

export type EventLogProps = { runId: string };

interface FollowState {
  following: boolean;
  pausedAtSeq: number;
}

const FOLLOWING: FollowState = { following: true, pausedAtSeq: 0 };
const NO_FAMILIES: ReadonlySet<EventFamily> = new Set();
const NO_KEYS: ReadonlySet<string> = new Set();
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

function toggled<Item>(previous: ReadonlySet<Item>, item: Item): ReadonlySet<Item> {
  const next = new Set(previous);
  if (next.has(item)) {
    next.delete(item);
  } else {
    next.add(item);
  }
  return next;
}

export function EventLog({ runId }: EventLogProps) {
  const headingId = useId();
  const { events } = useRunStreamHandle();
  const snapshot = useRunEventsPerFrame();
  const [selected, setSelected] = useState<ReadonlySet<EventFamily>>(NO_FAMILIES);
  const [showStream, setShowStream] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(NO_KEYS);
  const [follow, setFollow] = useState<FollowState>(FOLLOWING);
  const [restore, setRestore] = useState<RestoreRequest | null>(null);

  const counts = useMemo(() => countFamilies(snapshot.events), [snapshot.events]);
  const rows = useMemo(
    () =>
      buildLogRows({
        events: snapshot.events,
        streamEvents: snapshot.streamEvents,
        families: selected,
        showStream,
      }),
    [snapshot.events, snapshot.streamEvents, selected, showStream],
  );

  const total = snapshot.events.length;
  const filtered = selected.size > 0;
  const newCount = follow.following ? 0 : countRowsAfterSeq(rows, follow.pausedAtSeq);
  const announced = useThrottledValue(
    snapshot.loaded ? `${total} ${total === 1 ? "event" : "events"} in the log` : "",
    EVENT_LOG_ANNOUNCEMENT_INTERVAL_MS,
  );

  function pause(): void {
    setFollow((previous) =>
      previous.following ? { following: false, pausedAtSeq: snapshot.lastSeq } : previous,
    );
  }

  function handleFollowingChange(following: boolean): void {
    if (following) {
      setFollow(FOLLOWING);
    } else {
      pause();
    }
  }

  function toggleFamily(family: EventFamily): void {
    setSelected((previous) => toggled(previous, family));
    setFollow(FOLLOWING);
  }

  function clearFamilies(): void {
    setSelected(NO_FAMILIES);
    setFollow(FOLLOWING);
  }

  function toggleRow(key: string): void {
    setExpanded((previous) => toggled(previous, key));
    pause();
  }

  function loadOlder(): void {
    const first = rows[0];
    if (first !== undefined) {
      setRestore((previous) => ({ id: (previous?.id ?? 0) + 1, key: first.key }));
    }
    pause();
    void events.loadOlder();
  }

  return (
    <section
      aria-labelledby={headingId}
      data-slot="event-log"
      data-run-id={runId}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-base font-semibold">
          Event log
        </h2>
        <p className="text-xs text-muted-foreground" data-slot="event-summary">
          <span data-slot="event-count">{total}</span> events loaded, last seq{" "}
          <span data-slot="event-last-seq">{snapshot.lastSeq}</span>
          {filtered ? `, showing ${rows.length}` : ""}
        </p>
      </div>

      {snapshot.loaded ? (
        <>
          <EventFilters
            counts={counts}
            selected={selected}
            onToggleFamily={toggleFamily}
            onClear={clearFamilies}
            showStream={showStream}
            onShowStreamChange={setShowStream}
            streamCount={snapshot.streamEvents.length}
          />
          {snapshot.hasOlder || snapshot.olderError !== null ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                Older events are not loaded
                {snapshot.lowestSeq === null ? "" : `: the log starts at seq ${snapshot.lowestSeq}`}.
              </span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={snapshot.loadingOlder}
                onClick={loadOlder}
              >
                {snapshot.loadingOlder ? (
                  <LoaderCircle
                    aria-hidden="true"
                    data-icon="inline-start"
                    className="animate-spin motion-reduce:animate-none"
                  />
                ) : null}
                {snapshot.olderError === null ? "Load older events" : "Retry loading older events"}
              </Button>
              {snapshot.olderError === null ? null : (
                <span role="alert" className="text-verdict-fail-fg">
                  Could not load older events: {snapshot.olderError.message}
                </span>
              )}
            </div>
          ) : null}
          {snapshot.skippedCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {snapshot.skippedCount} {snapshot.skippedCount === 1 ? "event" : "events"} of a type
              this app does not know yet {snapshot.skippedCount === 1 ? "is" : "are"} not shown.
            </p>
          ) : null}
          {rows.length === 0 && total === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
              No events yet. They appear here as the run progresses.
            </p>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
              <p>No events match these filters.</p>
              <Button type="button" size="sm" variant="outline" onClick={clearFamilies}>
                Clear filters
              </Button>
            </div>
          ) : (
            <div className="relative">
              <EventList
                rows={rows}
                expandedKeys={expanded}
                onToggle={toggleRow}
                following={follow.following}
                onFollowingChange={handleFollowingChange}
                restore={restore}
                label="Run events, oldest first"
              />
              {follow.following ? null : (
                <Button
                  type="button"
                  size="sm"
                  className="absolute right-4 bottom-3 shadow-md"
                  onClick={() => setFollow(FOLLOWING)}
                >
                  <ArrowDown aria-hidden="true" data-icon="inline-start" />
                  Jump to latest
                  {newCount > 0 ? (
                    <span className="tabular-nums">{`(${newCount} new)`}</span>
                  ) : null}
                </Button>
              )}
            </div>
          )}
        </>
      ) : (
        <div aria-busy="true" className="flex flex-col gap-1.5">
          <span className="sr-only">Loading events</span>
          {SKELETON_ROWS.map((row) => (
            <Skeleton key={row} className="h-8 w-full" />
          ))}
        </div>
      )}

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-slot="event-log-live-region"
        className="sr-only"
      >
        {announced}
      </div>
    </section>
  );
}
