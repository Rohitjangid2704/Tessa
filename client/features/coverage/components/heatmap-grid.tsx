"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { cellIdAt, moveInGrid, type FeatureRow, type GridModel, type GridRow } from "../grid-model";
import { VIRTUALIZE_ROW_THRESHOLD } from "../schemas";
import type { CellFlashes } from "../use-coverage-feed";
import type { CoverageCell } from "../types";
import { AreaGroup } from "./area-group";
import { HeatmapCell } from "./heatmap-cell";

export const AREA_ROW_PX = 36;
export const FEATURE_ROW_PX = 56;
export const VIRTUAL_OVERSCAN_ROWS = 8;

const FIRST_COLUMN_WIDTH = "minmax(14rem, 18rem)";
const COLUMN_WIDTH = "minmax(7.5rem, 1fr)";
const MIN_FIRST_COLUMN = "14rem";
const MIN_COLUMN = "7.5rem";
const INITIAL_RECT = { width: 960, height: 560 };
const NAVIGATION_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export interface HeatmapGridProps {
  model: GridModel;
  activeCellId: string | null;
  onActiveCellChange: (cellId: string) => void;
  selectionMode: boolean;
  selectedIds: ReadonlySet<string>;
  flashes: CellFlashes;
  onCellActivate: (cell: CoverageCell, shiftKey: boolean) => void;
  label: string;
}

interface FeatureRowViewProps {
  row: FeatureRow;
  model: GridModel;
  rowIndex: number;
  template: string;
  style?: CSSProperties;
  activeCellId: string | null;
  selectionMode: boolean;
  selectedIds: ReadonlySet<string>;
  flashes: CellFlashes;
  onCellActivate: (cell: CoverageCell, shiftKey: boolean) => void;
  onActiveCellChange: (cellId: string) => void;
}

function FeatureRowView({
  row,
  model,
  rowIndex,
  template,
  style,
  activeCellId,
  selectionMode,
  selectedIds,
  flashes,
  onCellActivate,
  onActiveCellChange,
}: FeatureRowViewProps) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      data-slot="heatmap-row"
      data-feature-id={row.featureId}
      style={{ ...style, gridTemplateColumns: template }}
      className="grid items-stretch border-b"
    >
      <div
        role="rowheader"
        className="sticky left-0 z-10 flex min-w-0 flex-col justify-center bg-background px-3 py-1"
      >
        <span className="truncate text-sm font-medium" title={row.title}>
          {row.title}
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {row.featureId}
        </span>
      </div>
      {row.cells.map((cell, index) => {
        const column = model.columns[index];
        const key = `${row.key}:${column?.key ?? index}`;
        if (cell === null) {
          return (
            <div key={key} role="gridcell" className="p-0.5">
              <span className="sr-only">No cell for this feature, role and interface</span>
            </div>
          );
        }
        return (
          <HeatmapCell
            key={key}
            cell={cell}
            featureTitle={row.title}
            active={cell.id === activeCellId}
            selected={selectedIds.has(cell.id)}
            selectionMode={selectionMode}
            flashKey={flashes.get(cell.id)}
            onActivate={onCellActivate}
            onFocusCell={onActiveCellChange}
          />
        );
      })}
    </div>
  );
}

export function HeatmapGrid({
  model,
  activeCellId,
  onActiveCellChange,
  selectionMode,
  selectedIds,
  flashes,
  onCellActivate,
  label,
}: HeatmapGridProps) {
  "use no memo";

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualized = model.rows.length > VIRTUALIZE_ROW_THRESHOLD;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtualized ? model.rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (model.rows[index]?.kind === "area" ? AREA_ROW_PX : FEATURE_ROW_PX),
    overscan: VIRTUAL_OVERSCAN_ROWS,
    initialRect: INITIAL_RECT,
  });

  const columnCount = model.columns.length;
  const template = `${FIRST_COLUMN_WIDTH} repeat(${columnCount}, ${COLUMN_WIDTH})`;
  const minWidth = `calc(${MIN_FIRST_COLUMN} + ${columnCount} * ${MIN_COLUMN})`;
  const activeId =
    activeCellId !== null && model.cellsById.has(activeCellId)
      ? activeCellId
      : (model.cellOrder[0] ?? null);

  function focusCell(cellId: string, row: number): void {
    const focus = () => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-cell-id="${cellId}"]`)?.focus();
    };
    if (!virtualized) {
      focus();
      return;
    }
    virtualizer.scrollToIndex(row, { align: "auto" });
    requestAnimationFrame(() => requestAnimationFrame(focus));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !NAVIGATION_KEYS.has(event.key)) {
      return;
    }
    const cellId = target.dataset.cellId;
    const from = cellId === undefined ? undefined : model.positions.get(cellId);
    if (from === undefined) {
      return;
    }
    event.preventDefault();
    const next = moveInGrid(model, from, event.key, event.ctrlKey || event.metaKey);
    const nextId = next === null ? null : cellIdAt(model, next);
    if (next === null || nextId === null) {
      return;
    }
    onActiveCellChange(nextId);
    focusCell(nextId, next.row);
  }

  function renderRow(row: GridRow, index: number, style?: CSSProperties) {
    const rowIndex = index + 2;
    if (row.kind === "area") {
      return <AreaGroup key={row.key} row={row} rowIndex={rowIndex} style={style} />;
    }
    return (
      <FeatureRowView
        key={row.key}
        row={row}
        model={model}
        rowIndex={rowIndex}
        template={template}
        style={style}
        activeCellId={activeId}
        selectionMode={selectionMode}
        selectedIds={selectedIds}
        flashes={flashes}
        onCellActivate={onCellActivate}
        onActiveCellChange={onActiveCellChange}
      />
    );
  }

  return (
    <div
      ref={scrollRef}
      data-slot="heatmap-scroll"
      data-virtualized={virtualized}
      className="max-h-[70vh] overflow-auto rounded-lg border bg-card"
    >
      <div
        role="grid"
        aria-label={label}
        aria-rowcount={model.rows.length + 1}
        aria-colcount={columnCount + 1}
        aria-multiselectable={selectionMode ? true : undefined}
        data-slot="heatmap-grid"
        onKeyDown={handleKeyDown}
        style={{ minWidth }}
      >
        <div
          role="row"
          aria-rowindex={1}
          data-slot="heatmap-header"
          style={{ gridTemplateColumns: template }}
          className="sticky top-0 z-20 grid border-b bg-background"
        >
          <div
            role="columnheader"
            className="sticky left-0 z-30 bg-background px-3 py-2 text-xs font-medium text-muted-foreground"
          >
            Feature
          </div>
          {model.columns.map((column) => (
            <div
              key={column.key}
              role="columnheader"
              aria-label={`${column.role} on ${column.interfaceId}`}
              className="flex min-w-0 flex-col justify-center px-2 py-1.5"
            >
              <span className="truncate text-xs font-semibold">{column.role}</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {column.interfaceId}
              </span>
            </div>
          ))}
        </div>
        {virtualized ? (
          <div
            role="none"
            style={{ height: virtualizer.getTotalSize() }}
            className={cn("relative w-full")}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = model.rows[item.index];
              if (row === undefined) {
                return null;
              }
              return renderRow(row, item.index, {
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: item.size,
                transform: `translateY(${item.start}px)`,
              });
            })}
          </div>
        ) : (
          model.rows.map((row, index) => renderRow(row, index))
        )}
      </div>
    </div>
  );
}
