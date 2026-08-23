export { AreaTree, type AreaTreeProps } from "./components/area-tree";
export { CatalogExplorer, CatalogView, type CatalogExplorerProps } from "./components/catalog-view";
export { ConfidenceChip } from "./components/confidence-chip";
export { ChipList, type ChipListProps } from "./components/chip-list";
export { FeatureCard, type FeatureCardProps } from "./components/feature-card";
export { KindBadge } from "./components/kind-badge";
export {
  areaTotals,
  catalogQuery,
  interfaceKindMap,
  itemCount,
  type CatalogRequest,
} from "./queries";
export {
  catalogFiltersCodec,
  catalogFiltersSchema,
  CONFIDENCES,
  FEATURE_KINDS,
  type CatalogFilterValues,
} from "./schemas";
export { areaSelectionState, type AreaSelectionState, type CatalogSelection } from "./selection";
export type {
  Catalog,
  CatalogArea,
  CatalogExample,
  CatalogInterface,
  CatalogItem,
  CatalogRole,
  Confidence,
  FeatureKind,
} from "./types";
