import type { Proposal, ProposalItem, ProposalItemChoice, ProposalItemStatus } from "./types";

export function isLocked(item: ProposalItem): boolean {
  return item.status === "authored" || item.status === "covered";
}

export function isSelectedItem(item: ProposalItem): boolean {
  return item.status === "selected";
}

export function selectedItems(items: readonly ProposalItem[]): ProposalItem[] {
  return items.filter(isSelectedItem);
}

export function selectedItemIds(items: readonly ProposalItem[]): string[] {
  return selectedItems(items).map((item) => item.id);
}

export interface AreaSelectionSummary {
  total: number;
  selected: number;
  declined: number;
  locked: number;
  selectable: number;
}

export function summarizeArea(items: readonly ProposalItem[]): AreaSelectionSummary {
  return {
    total: items.length,
    selected: items.filter(isSelectedItem).length,
    declined: items.filter((item) => item.status === "declined").length,
    locked: items.filter(isLocked).length,
    selectable: items.filter((item) => item.status === "proposed").length,
  };
}

export function itemsToSelect(items: readonly ProposalItem[]): ProposalItem[] {
  return items.filter((item) => item.status === "proposed");
}

export function itemsToClear(items: readonly ProposalItem[]): ProposalItem[] {
  return items.filter(isSelectedItem);
}

export interface ItemChange {
  ids: readonly string[];
  choice: ProposalItemChoice;
  note?: string | null;
}

function noteAfter(item: ProposalItem, change: ItemChange): string | null {
  if (change.note !== undefined) {
    return change.note === null || change.note.trim() === "" ? null : change.note.trim();
  }
  return change.choice === "proposed" ? null : item.note;
}

export function applyItemChange(proposal: Proposal | null, change: ItemChange): Proposal | null {
  if (proposal === null) {
    return proposal;
  }
  const ids = new Set(change.ids);
  return {
    ...proposal,
    items: proposal.items.map((item) => {
      if (!ids.has(item.id) || isLocked(item)) {
        return item;
      }
      return {
        ...item,
        status: change.choice,
        note: noteAfter(item, change),
        selected_by: change.choice === "proposed" ? null : item.selected_by,
      };
    }),
  };
}

export function changedItemIds(
  base: Proposal | null,
  optimistic: Proposal | null,
): ReadonlySet<string> {
  const changed = new Set<string>();
  if (base === null || optimistic === null) {
    return changed;
  }
  const original = new Map(base.items.map((item) => [item.id, item]));
  for (const item of optimistic.items) {
    const before = original.get(item.id);
    if (before !== undefined && (before.status !== item.status || before.note !== item.note)) {
      changed.add(item.id);
    }
  }
  return changed;
}

export function countByStatus(items: readonly ProposalItem[]): Record<ProposalItemStatus, number> {
  const counts: Record<ProposalItemStatus, number> = {
    proposed: 0,
    selected: 0,
    declined: 0,
    authored: 0,
    covered: 0,
  };
  for (const item of items) {
    counts[item.status] += 1;
  }
  return counts;
}
