"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { pluralize } from "@/features/bundles/format";
import { type AreaGroup } from "../filters";
import { itemsToClear, itemsToSelect, summarizeArea } from "../selection";
import type { ProposalItem, ProposalItemChoice } from "../types";
import { ProposalItemCard } from "./proposal-item-card";

export const VIRTUALIZE_CARD_THRESHOLD = 50;
export const AREA_ROW_ESTIMATE_PX = 52;
export const CARD_ROW_ESTIMATE_PX = 200;
export const VIRTUAL_OVERSCAN_ROWS = 6;
const INITIAL_RECT = { width: 960, height: 640 };

type BoardRow =
  | { kind: "area"; key: string; group: AreaGroup }
  | { kind: "item"; key: string; item: ProposalItem };

export interface ProposalBoardProps {
  targetId: string;
  groups: readonly AreaGroup[];
  canEdit: boolean;
  pendingIds: ReadonlySet<string>;
  onChange: (
    items: readonly ProposalItem[],
    choice: ProposalItemChoice,
    note?: string | null,
  ) => void;
}

export function flattenGroups(groups: readonly AreaGroup[]): BoardRow[] {
  return groups.flatMap((group) => [
    { kind: "area" as const, key: `area:${group.area}`, group },
    ...group.items.map((item) => ({ kind: "item" as const, key: `item:${item.id}`, item })),
  ]);
}

export function countCards(groups: readonly AreaGroup[]): number {
  return groups.reduce((total, group) => total + group.items.length, 0);
}

interface AreaHeaderProps {
  group: AreaGroup;
  canEdit: boolean;
  onChange: ProposalBoardProps["onChange"];
}

function AreaHeader({ group, canEdit, onChange }: AreaHeaderProps) {
  const summary = summarizeArea(group.items);
  return (
    <div
      data-slot="proposal-area"
      data-area={group.area}
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b pb-2"
    >
      <div className="flex flex-col">
        <h3 className="text-base font-semibold">{group.area}</h3>
        <p className="text-xs text-muted-foreground tabular-nums">
          {pluralize(summary.total, "item")}, {summary.selected} selected
        </p>
      </div>
      {canEdit ? (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={summary.selectable === 0}
            onClick={() => onChange(itemsToSelect(group.items), "selected")}
            aria-label={`Select all proposed items in ${group.area}`}
          >
            Select all
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={summary.selected === 0}
            onClick={() => onChange(itemsToClear(group.items), "proposed")}
            aria-label={`Clear the selection in ${group.area}`}
          >
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ProposalBoard({
  targetId,
  groups,
  canEdit,
  pendingIds,
  onChange,
}: ProposalBoardProps) {
  "use no memo";

  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = flattenGroups(groups);
  const virtualized = countCards(groups) > VIRTUALIZE_CARD_THRESHOLD;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtualized ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      rows[index]?.kind === "area" ? AREA_ROW_ESTIMATE_PX : CARD_ROW_ESTIMATE_PX,
    overscan: VIRTUAL_OVERSCAN_ROWS,
    initialRect: INITIAL_RECT,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  function renderRow(row: BoardRow) {
    if (row.kind === "area") {
      return <AreaHeader group={row.group} canEdit={canEdit} onChange={onChange} />;
    }
    return (
      <ProposalItemCard
        item={row.item}
        targetId={targetId}
        canEdit={canEdit}
        pending={pendingIds.has(row.item.id)}
        onChoose={(item, choice, note) => onChange([item], choice, note)}
      />
    );
  }

  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label="Proposal items"
      tabIndex={0}
      data-slot="proposal-board"
      data-virtualized={virtualized}
      data-cards={countCards(groups)}
      className={
        virtualized ? "max-h-[70vh] overflow-auto rounded-lg border p-3" : "flex flex-col gap-3"
      }
    >
      {virtualized ? (
        <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (row === undefined) {
              return null;
            }
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                }}
                className="pb-3"
              >
                {renderRow(row)}
              </div>
            );
          })}
        </div>
      ) : (
        rows.map((row) => (
          <div key={row.key} className={row.kind === "area" ? "pt-3 first:pt-0" : undefined}>
            {renderRow(row)}
          </div>
        ))
      )}
    </div>
  );
}
