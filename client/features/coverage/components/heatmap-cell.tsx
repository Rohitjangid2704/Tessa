"use client";

import { Lightbulb, Square, SquareCheck } from "lucide-react";
import type { MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { CELL_STATUS_LABELS, CELL_STATUS_SHORT_LABELS, VERDICT_LABELS } from "../labels";
import { proposalItemIdsOf } from "../selection";
import type { CoverageCell } from "../types";
import { CELL_STATUS_STYLES, CellStatusIcon, LastVerdictMark } from "./cell-status";

export interface HeatmapCellProps {
  cell: CoverageCell;
  featureTitle: string;
  active: boolean;
  selected: boolean;
  selectionMode: boolean;
  flashKey: number | undefined;
  onActivate: (cell: CoverageCell, shiftKey: boolean) => void;
  onFocusCell: (cellId: string) => void;
}

export function describeCell(cell: CoverageCell, featureTitle: string): string {
  const parts = [
    `${featureTitle}, ${cell.role} on ${cell.interface_id}`,
    CELL_STATUS_LABELS[cell.status],
  ];
  if (cell.last_verdict !== null) {
    parts.push(`last verdict ${VERDICT_LABELS[cell.last_verdict]}`);
  }
  parts.push(
    cell.scenario_count === 1 ? "1 scenario" : `${cell.scenario_count} scenarios`,
  );
  if (proposalItemIdsOf(cell).length > 0) {
    parts.push("proposed in the test proposal");
  }
  return parts.join(", ");
}

export function ProposedMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-slot="proposed-mark"
      className={cn(
        "absolute right-1 bottom-1 inline-flex size-4 items-center justify-center rounded-sm border border-proposed-fg/40 bg-proposed-bg text-proposed-fg",
        className,
      )}
    >
      <Lightbulb className="size-2.5" />
    </span>
  );
}

export function HeatmapCell({
  cell,
  featureTitle,
  active,
  selected,
  selectionMode,
  flashKey,
  onActivate,
  onFocusCell,
}: HeatmapCellProps) {
  const style = CELL_STATUS_STYLES[cell.status];

  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    onActivate(cell, event.shiftKey);
  }

  return (
    <div
      role="gridcell"
      aria-selected={selectionMode ? selected : undefined}
      data-slot="heatmap-cell"
      className="p-0.5"
    >
      <button
        type="button"
        data-cell-id={cell.id}
        data-status={cell.status}
        tabIndex={active ? 0 : -1}
        aria-label={describeCell(cell, featureTitle)}
        aria-pressed={selectionMode ? selected : undefined}
        onClick={handleClick}
        onFocus={() => onFocusCell(cell.id)}
        className={cn(
          "relative flex h-12 w-full flex-col justify-center gap-0.5 overflow-hidden rounded-md border px-2 text-left text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/60",
          style.tone,
          style.outline,
          style.pattern,
          selected && "ring-2 ring-foreground",
        )}
      >
        {flashKey === undefined ? null : (
          <span
            key={flashKey}
            aria-hidden="true"
            data-slot="cell-flash"
            className="cell-flash-overlay pointer-events-none absolute inset-0"
          />
        )}
        <span className="relative flex items-center gap-1.5 font-medium">
          {selectionMode ? (
            selected ? (
              <SquareCheck aria-hidden="true" className="size-3.5 shrink-0" />
            ) : (
              <Square aria-hidden="true" className="size-3.5 shrink-0" />
            )
          ) : (
            <CellStatusIcon status={cell.status} />
          )}
          <span className="truncate">{CELL_STATUS_SHORT_LABELS[cell.status]}</span>
          <LastVerdictMark verdict={cell.last_verdict} className="ml-auto" />
        </span>
        <span className="relative truncate text-[11px] opacity-90">
          {cell.scenario_count === 0
            ? "No scenarios"
            : cell.scenario_count === 1
              ? "1 scenario"
              : `${cell.scenario_count} scenarios`}
        </span>
        {proposalItemIdsOf(cell).length === 0 ? null : <ProposedMark />}
      </button>
    </div>
  );
}
