import { emptyCounts } from "./grid-model";
import type { CellStatus, CoverageCell } from "./types";

export interface SelectionState {
  mode: boolean;
  ids: ReadonlySet<string>;
  anchor: string | null;
}

export type SelectionAction =
  | { type: "set_mode"; mode: boolean }
  | { type: "toggle"; cellId: string }
  | { type: "select_range"; cellIds: readonly string[]; anchor: string }
  | { type: "clear" };

export function createInitialSelection(): SelectionState {
  return { mode: false, ids: new Set<string>(), anchor: null };
}

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case "set_mode":
      return action.mode
        ? { ...state, mode: true }
        : { mode: false, ids: new Set<string>(), anchor: null };
    case "toggle": {
      const ids = new Set(state.ids);
      if (ids.has(action.cellId)) {
        ids.delete(action.cellId);
      } else {
        ids.add(action.cellId);
      }
      return { mode: true, ids, anchor: action.cellId };
    }
    case "select_range": {
      const ids = new Set(state.ids);
      for (const cellId of action.cellIds) {
        ids.add(cellId);
      }
      return { mode: true, ids, anchor: action.anchor };
    }
    case "clear":
      return { ...state, ids: new Set<string>(), anchor: null };
  }
}

export interface SelectionSummary {
  total: number;
  byStatus: Record<CellStatus, number>;
  generatable: CoverageCell[];
  authorable: CoverageCell[];
  blocked: CoverageCell[];
}

export function summarizeSelection(cells: readonly CoverageCell[]): SelectionSummary {
  const byStatus = emptyCounts();
  for (const cell of cells) {
    byStatus[cell.status] += 1;
  }
  return {
    total: cells.length,
    byStatus,
    generatable: cells.filter((cell) => cell.status === "empty"),
    authorable: cells.filter((cell) => cell.status === "needs_author" || cell.status === "empty"),
    blocked: cells.filter((cell) => cell.status === "blocked"),
  };
}

export function selectedCellsOf(
  ids: ReadonlySet<string>,
  cellsById: ReadonlyMap<string, CoverageCell>,
  order: readonly string[],
): CoverageCell[] {
  return order.flatMap((cellId) => {
    const cell = cellsById.get(cellId);
    return ids.has(cellId) && cell !== undefined ? [cell] : [];
  });
}

export function proposalItemIdsOf(cell: CoverageCell): readonly string[] {
  return cell.proposal_item_ids ?? [];
}

export function itemIdsCoveringAll(cells: readonly CoverageCell[]): string[] | null {
  if (cells.length === 0 || cells.some((cell) => proposalItemIdsOf(cell).length === 0)) {
    return null;
  }
  return [...new Set(cells.flatMap(proposalItemIdsOf))];
}

export function proposedCellCount(cells: readonly CoverageCell[]): number {
  return cells.filter((cell) => proposalItemIdsOf(cell).length > 0).length;
}
