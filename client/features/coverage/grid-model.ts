import { CELL_STATUSES } from "./labels";
import type { CellStatus, CoverageCell, CoverageMap } from "./types";

export interface GridColumn {
  key: string;
  role: string;
  interfaceId: string;
  index: number;
}

export interface AreaRow {
  kind: "area";
  key: string;
  area: string;
  featureCount: number;
  counts: Record<CellStatus, number>;
}

export interface FeatureRow {
  kind: "feature";
  key: string;
  featureId: string;
  title: string;
  area: string;
  cells: ReadonlyArray<CoverageCell | null>;
}

export type GridRow = AreaRow | FeatureRow;

export interface CellPosition {
  row: number;
  column: number;
}

export interface GridFilters {
  status?: readonly CellStatus[];
  area?: readonly string[];
}

export interface GridModel {
  columns: readonly GridColumn[];
  rows: readonly GridRow[];
  featureRowCount: number;
  cellOrder: readonly string[];
  positions: ReadonlyMap<string, CellPosition>;
  cellsById: ReadonlyMap<string, CoverageCell>;
  visibleCellCount: number;
}

const PAGE_STEP = 10;

export function columnKey(role: string, interfaceId: string): string {
  return `${role}|${interfaceId}`;
}

export function emptyCounts(): Record<CellStatus, number> {
  return { empty: 0, generated: 0, covered: 0, needs_author: 0, blocked: 0 };
}

function cellKeyOf(cell: Pick<CoverageCell, "feature_id" | "role" | "interface_id">): string {
  return `${cell.feature_id}|${columnKey(cell.role, cell.interface_id)}`;
}

function matchesStatus(cell: CoverageCell, status: readonly CellStatus[] | undefined): boolean {
  return status === undefined || status.length === 0 || status.includes(cell.status);
}

export function buildGridModel(map: CoverageMap, filters: GridFilters = {}): GridModel {
  const columns = map.columns.map(
    (column, index): GridColumn => ({
      key: columnKey(column.role, column.interface_id),
      role: column.role,
      interfaceId: column.interface_id,
      index,
    }),
  );
  const byKey = new Map<string, CoverageCell>();
  for (const cell of map.cells) {
    byKey.set(cellKeyOf(cell), cell);
  }
  const areaFilter = filters.area === undefined || filters.area.length === 0 ? null : filters.area;

  const grouped = new Map<string, FeatureRow[]>();
  for (const row of map.rows) {
    if (areaFilter !== null && !areaFilter.includes(row.area)) {
      continue;
    }
    const slots = columns.map((column) => {
      const cell = byKey.get(`${row.feature_id}|${column.key}`) ?? null;
      return cell !== null && matchesStatus(cell, filters.status) ? cell : null;
    });
    if (slots.every((slot) => slot === null)) {
      continue;
    }
    const featureRow: FeatureRow = {
      kind: "feature",
      key: `feature:${row.feature_id}`,
      featureId: row.feature_id,
      title: row.title,
      area: row.area,
      cells: slots,
    };
    grouped.set(row.area, [...(grouped.get(row.area) ?? []), featureRow]);
  }

  const rows: GridRow[] = [];
  const cellOrder: string[] = [];
  const positions = new Map<string, CellPosition>();
  const cellsById = new Map<string, CoverageCell>();
  let featureRowCount = 0;
  for (const [area, featureRows] of grouped) {
    const counts = emptyCounts();
    for (const featureRow of featureRows) {
      for (const cell of featureRow.cells) {
        if (cell !== null) {
          counts[cell.status] += 1;
        }
      }
    }
    rows.push({
      kind: "area",
      key: `area:${area}`,
      area,
      featureCount: featureRows.length,
      counts,
    });
    for (const featureRow of featureRows) {
      const rowIndex = rows.length;
      rows.push(featureRow);
      featureRowCount += 1;
      featureRow.cells.forEach((cell, column) => {
        if (cell !== null) {
          cellOrder.push(cell.id);
          positions.set(cell.id, { row: rowIndex, column });
          cellsById.set(cell.id, cell);
        }
      });
    }
  }
  return {
    columns,
    rows,
    featureRowCount,
    cellOrder,
    positions,
    cellsById,
    visibleCellCount: cellOrder.length,
  };
}

export function areaNamesOf(map: CoverageMap): string[] {
  return [...new Set(map.rows.map((row) => row.area))];
}

export function totalOfTotals(totals: Record<CellStatus, number>): number {
  return CELL_STATUSES.reduce((sum, status) => sum + totals[status], 0);
}

function cellAt(model: GridModel, row: number, column: number): CoverageCell | null {
  const candidate = model.rows[row];
  return candidate?.kind === "feature" ? (candidate.cells[column] ?? null) : null;
}

function firstCellInRow(model: GridModel, row: number, from: number, step: 1 | -1): number | null {
  for (let column = from; column >= 0 && column < model.columns.length; column += step) {
    if (cellAt(model, row, column) !== null) {
      return column;
    }
  }
  return null;
}

function nextRowWithCell(
  model: GridModel,
  from: number,
  column: number,
  step: 1 | -1,
  distance: number,
): number | null {
  let found: number | null = null;
  let travelled = 0;
  for (let row = from + step; row >= 0 && row < model.rows.length; row += step) {
    if (cellAt(model, row, column) !== null) {
      found = row;
      travelled += 1;
      if (travelled >= distance) {
        break;
      }
    }
  }
  return found;
}

export function moveInGrid(
  model: GridModel,
  from: CellPosition,
  key: string,
  withControl: boolean,
): CellPosition | null {
  switch (key) {
    case "ArrowRight": {
      const column = firstCellInRow(model, from.row, from.column + 1, 1);
      return column === null ? null : { row: from.row, column };
    }
    case "ArrowLeft": {
      const column = firstCellInRow(model, from.row, from.column - 1, -1);
      return column === null ? null : { row: from.row, column };
    }
    case "ArrowDown":
    case "PageDown": {
      const row = nextRowWithCell(model, from.row, from.column, 1, key === "PageDown" ? PAGE_STEP : 1);
      return row === null ? null : { row, column: from.column };
    }
    case "ArrowUp":
    case "PageUp": {
      const row = nextRowWithCell(model, from.row, from.column, -1, key === "PageUp" ? PAGE_STEP : 1);
      return row === null ? null : { row, column: from.column };
    }
    case "Home": {
      if (withControl) {
        const first = model.cellOrder[0];
        return first === undefined ? null : (model.positions.get(first) ?? null);
      }
      const column = firstCellInRow(model, from.row, 0, 1);
      return column === null ? null : { row: from.row, column };
    }
    case "End": {
      if (withControl) {
        const last = model.cellOrder.at(-1);
        return last === undefined ? null : (model.positions.get(last) ?? null);
      }
      const column = firstCellInRow(model, from.row, model.columns.length - 1, -1);
      return column === null ? null : { row: from.row, column };
    }
    default:
      return null;
  }
}

export function cellIdAt(model: GridModel, position: CellPosition): string | null {
  return cellAt(model, position.row, position.column)?.id ?? null;
}

export function rangeBetween(
  model: GridModel,
  anchorId: string,
  targetId: string,
): readonly string[] {
  const anchor = model.cellOrder.indexOf(anchorId);
  const target = model.cellOrder.indexOf(targetId);
  if (anchor === -1 || target === -1) {
    return [targetId];
  }
  const [start, end] = anchor <= target ? [anchor, target] : [target, anchor];
  return model.cellOrder.slice(start, end + 1);
}
