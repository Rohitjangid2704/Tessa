"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, type UIEvent } from "react";
import { cn } from "@/lib/utils";
import type { LogRow } from "../event-log-model";
import { EventRow } from "./event-row";

export const ROW_ESTIMATE_PX = 34;
export const FOLLOW_THRESHOLD_PX = 32;
export const OVERSCAN_ROWS = 12;
export const LIST_HEIGHT_PX = 384;

const INITIAL_RECT = { width: 640, height: LIST_HEIGHT_PX };

export interface RestoreRequest {
  id: number;
  key: string;
}

export type EventListProps = {
  rows: readonly LogRow[];
  expandedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  following: boolean;
  onFollowingChange: (following: boolean) => void;
  restore: RestoreRequest | null;
  label: string;
  className?: string;
};

export function EventList({
  rows,
  expandedKeys,
  onToggle,
  following,
  onFollowingChange,
  restore,
  label,
  className,
}: EventListProps) {
  "use no memo";

  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  const handledRestore = useRef(0);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLLIElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: OVERSCAN_ROWS,
    initialRect: INITIAL_RECT,
  });

  const rowCount = rows.length;
  const lastKey = rows[rowCount - 1]?.key;
  const viewportHeight = virtualizer.scrollRect?.height ?? 0;

  useLayoutEffect(() => {
    if (following && rowCount > 0 && viewportHeight > 0) {
      virtualizer.scrollToIndex(rowCount - 1, { align: "end" });
    }
  }, [following, rowCount, lastKey, viewportHeight, virtualizer]);

  useLayoutEffect(() => {
    if (restore === null || restore.id === handledRestore.current) {
      return;
    }
    const index = rows.findIndex((row) => row.key === restore.key);
    if (index > 0) {
      handledRestore.current = restore.id;
      virtualizer.scrollToIndex(index, { align: "start" });
    }
  }, [restore, rows, virtualizer]);

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const scrolledUp = element.scrollTop < lastScrollTop.current - 1;
    lastScrollTop.current = element.scrollTop;
    if (distanceFromBottom <= FOLLOW_THRESHOLD_PX) {
      if (!following) {
        onFollowingChange(true);
      }
    } else if (scrolledUp && following) {
      onFollowingChange(false);
    }
  }

  return (
    <div
      ref={scrollRef}
      role="group"
      aria-label={label}
      tabIndex={0}
      onScroll={handleScroll}
      data-slot="event-list"
      data-following={following ? "true" : "false"}
      style={{ height: LIST_HEIGHT_PX }}
      className={cn(
        "relative overflow-auto rounded-lg border bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      <ul
        style={{ height: virtualizer.getTotalSize() }}
        className="relative m-0 w-full list-none p-0"
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (row === undefined) {
            return null;
          }
          return (
            <EventRow
              key={row.key}
              row={row}
              expanded={expandedKeys.has(row.key)}
              onToggle={onToggle}
              index={item.index}
              position={item.index + 1}
              total={rowCount}
              offset={item.start}
              measureRef={virtualizer.measureElement}
            />
          );
        })}
      </ul>
    </div>
  );
}
