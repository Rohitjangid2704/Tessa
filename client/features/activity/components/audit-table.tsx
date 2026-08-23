"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { CopyButton } from "@/components/copy-button";
import { DateTime } from "@/components/date-time";
import type { AuditEvent } from "@/lib/api/types";
import { settingsRoutes, withQuery } from "@/lib/routes";
import { describeDetail, requestIdOf, shortId } from "../detail";
import { auditActionLabel, auditSubjectLabel } from "../labels";
import { ViaChip } from "./via-chip";

export const AUDIT_ROW_HEIGHT_PX = 64;
export const AUDIT_OVERSCAN_ROWS = 8;
export const AUDIT_LOAD_AHEAD_ROWS = 20;
export const AUDIT_TABLE_HEIGHT_PX = 560;

const INITIAL_RECT = { width: 1200, height: AUDIT_TABLE_HEIGHT_PX };
const GRID_COLUMNS = "grid-cols-[11rem_10rem_13rem_minmax(16rem,1fr)_9rem_8rem_8rem] min-w-[78rem]";

const COLUMN_HEADERS = ["Time", "Actor", "Action", "Subject", "Via", "Session", "Request"] as const;

export type AuditTableProps = {
  rows: readonly AuditEvent[];
  actorNames: ReadonlyMap<string, string>;
  total: number | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
};

export function actorLabel(event: AuditEvent, names: ReadonlyMap<string, string>): string {
  if (event.actor_user_id === null) {
    return "System";
  }
  return names.get(event.actor_user_id) ?? `User ${shortId(event.actor_user_id)}`;
}

export function sessionHref(sessionId: string) {
  return withQuery(settingsRoutes.activity(), { session: sessionId });
}

function AuditRow({
  event,
  index,
  offset,
  actorNames,
}: {
  event: AuditEvent;
  index: number;
  offset: number;
  actorNames: ReadonlyMap<string, string>;
}) {
  const requestId = requestIdOf(event);
  const detail = describeDetail(event);
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      data-slot="audit-row"
      data-action={event.action}
      data-via={event.via}
      style={{ height: AUDIT_ROW_HEIGHT_PX, transform: `translateY(${offset}px)` }}
      className={`absolute top-0 left-0 grid w-full items-center gap-x-3 border-b px-3 ${GRID_COLUMNS}`}
    >
      <div role="cell" className="text-sm">
        <DateTime value={event.created_at} />
      </div>
      <div role="cell" className="truncate text-sm font-medium">
        {actorLabel(event, actorNames)}
      </div>
      <div role="cell" className="text-sm">
        <span className="line-clamp-2">{auditActionLabel(event.action)}</span>
      </div>
      <div role="cell" className="flex min-w-0 flex-col gap-0.5 text-sm">
        <span className="flex flex-wrap items-center gap-x-2">
          <span>{auditSubjectLabel(event.subject_type)}</span>
          {event.subject_id === null ? null : (
            <code className="font-mono text-xs text-muted-foreground" title={event.subject_id}>
              {shortId(event.subject_id)}
            </code>
          )}
        </span>
        {detail === "" ? null : (
          <span
            data-slot="audit-detail"
            title={detail}
            className="line-clamp-1 font-mono text-xs text-muted-foreground"
          >
            {detail}
          </span>
        )}
      </div>
      <div role="cell">
        <ViaChip via={event.via} />
      </div>
      <div role="cell" className="text-sm">
        {event.agent_session_id === null ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <Link
            href={sessionHref(event.agent_session_id)}
            className="underline underline-offset-4"
            aria-label={`Show the events of session ${shortId(event.agent_session_id)}`}
          >
            <code className="font-mono text-xs">{shortId(event.agent_session_id)}</code>
          </Link>
        )}
      </div>
      <div role="cell">
        {requestId === null ? (
          <span className="text-sm text-muted-foreground">None</span>
        ) : (
          <CopyButton
            text={requestId}
            subject={`request id ${requestId}`}
            variant="ghost"
            size="xs"
          />
        )}
      </div>
    </div>
  );
}

export function AuditTable({
  rows,
  actorNames,
  total,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: AuditTableProps) {
  "use no memo";

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => AUDIT_ROW_HEIGHT_PX,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: AUDIT_OVERSCAN_ROWS,
    initialRect: INITIAL_RECT,
  });

  const items = virtualizer.getVirtualItems();
  const lastIndex = items.at(-1)?.index ?? -1;
  const nearEnd = lastIndex >= rows.length - AUDIT_LOAD_AHEAD_ROWS;

  useEffect(() => {
    if (nearEnd && hasNextPage && !isFetchingNextPage) {
      onLoadMore();
    }
  }, [nearEnd, hasNextPage, isFetchingNextPage, onLoadMore, rows.length]);

  return (
    <div
      ref={scrollRef}
      role="table"
      aria-label="Audit events"
      aria-rowcount={(total ?? rows.length) + 1}
      tabIndex={0}
      data-slot="audit-table"
      data-loaded={rows.length}
      style={{ height: AUDIT_TABLE_HEIGHT_PX }}
      className="relative overflow-auto rounded-lg border bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <div role="rowgroup" className="sticky top-0 z-10 bg-muted">
        <div
          role="row"
          aria-rowindex={1}
          className={`grid h-10 items-center gap-x-3 border-b px-3 text-xs font-medium text-muted-foreground ${GRID_COLUMNS}`}
        >
          {COLUMN_HEADERS.map((header) => (
            <div key={header} role="columnheader">
              {header}
            </div>
          ))}
        </div>
      </div>
      <div
        role="rowgroup"
        style={{ height: virtualizer.getTotalSize() }}
        className="relative min-w-[78rem]"
      >
        {items.map((item) => {
          const event = rows[item.index];
          if (event === undefined) {
            return null;
          }
          return (
            <AuditRow
              key={event.id}
              event={event}
              index={item.index}
              offset={item.start}
              actorNames={actorNames}
            />
          );
        })}
      </div>
    </div>
  );
}
