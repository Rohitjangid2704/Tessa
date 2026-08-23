"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import { isItemOpenByDefault, type ItemListRow } from "../model";
import { GroupRow, ItemRow } from "./item-row";

export const GROUP_ROW_ESTIMATE_PX = 40;
export const COLLAPSED_ITEM_ESTIMATE_PX = 52;
export const EXPANDED_ITEM_ESTIMATE_PX = 420;
export const OVERSCAN_ROWS = 6;
export const LIST_HEIGHT_PX = 640;
export const LIST_MAX_HEIGHT = "75vh";

const INITIAL_RECT = { width: 960, height: LIST_HEIGHT_PX };

export type ItemListProps = {
  rows: readonly ItemListRow[];
  toggledKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  label: string;
  className?: string;
};

function isRowExpanded(row: ItemListRow, toggledKeys: ReadonlySet<string>): boolean {
  return row.kind === "item" && isItemOpenByDefault(row.item) !== toggledKeys.has(row.key);
}

function estimateRowHeight(row: ItemListRow | undefined, toggledKeys: ReadonlySet<string>): number {
  if (row === undefined || row.kind === "group") {
    return GROUP_ROW_ESTIMATE_PX;
  }
  return isRowExpanded(row, toggledKeys) ? EXPANDED_ITEM_ESTIMATE_PX : COLLAPSED_ITEM_ESTIMATE_PX;
}

export function ItemList({ rows, toggledKeys, onToggle, label, className }: ItemListProps) {
  "use no memo";

  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLLIElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index: number) => estimateRowHeight(rows[index], toggledKeys),
    getItemKey: (index: number) => rows[index]?.key ?? index,
    overscan: OVERSCAN_ROWS,
    initialRect: INITIAL_RECT,
  });

  const total = rows.length;

  return (
    <div
      ref={scrollRef}
      role="group"
      aria-label={label}
      tabIndex={0}
      data-slot="contract-item-list"
      style={{ height: LIST_HEIGHT_PX, maxHeight: LIST_MAX_HEIGHT }}
      className={cn(
        "relative overflow-auto rounded-lg border bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      <ul
        style={{ height: virtualizer.getTotalSize() }}
        className="relative m-0 w-full list-none p-0"
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (row === undefined) {
            return null;
          }
          const placement = {
            index: virtualRow.index,
            position: virtualRow.index + 1,
            total,
            offset: virtualRow.start,
            measureRef: virtualizer.measureElement,
          };
          if (row.kind === "group") {
            return (
              <GroupRow
                key={row.key}
                interfaceId={row.interfaceId}
                counts={row.counts}
                {...placement}
              />
            );
          }
          return (
            <ItemRow
              key={row.key}
              rowKey={row.key}
              item={row.item}
              expanded={isRowExpanded(row, toggledKeys)}
              onToggle={onToggle}
              {...placement}
            />
          );
        })}
      </ul>
    </div>
  );
}
