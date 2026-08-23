import type { CatalogArea, CatalogItem } from "./types";

export interface CatalogSelection {
  isSelected: (itemId: string) => boolean;
  onToggleItem: (item: CatalogItem, selected: boolean) => void;
  onToggleArea: (area: CatalogArea, selected: boolean) => void;
}

export type AreaSelectionState = "all" | "some" | "none";

export function areaSelectionState(
  area: CatalogArea,
  isSelected: (itemId: string) => boolean,
): AreaSelectionState {
  const selectedCount = area.items.filter((item) => isSelected(item.id)).length;
  if (selectedCount === 0) {
    return "none";
  }
  return selectedCount === area.items.length ? "all" : "some";
}
