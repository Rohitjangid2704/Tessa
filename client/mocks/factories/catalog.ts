import type { components } from "@/lib/api/schema";
import type { InterimSchemas } from "@/lib/api/types";
import { newId } from "./ids";

type Schemas = components["schemas"];

export type Catalog = Schemas["Catalog"];
export type CatalogItem = Schemas["CatalogItem"] &
  Partial<InterimSchemas["CatalogItemProposalFields"]>;
export type CatalogArea = Schemas["CatalogArea"];
export type CatalogRole = Schemas["CatalogRole"];
export type CatalogInterface = Schemas["CatalogInterface"];

export function buildCatalogItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: newId(),
    bundle_id: newId(),
    feature_id: "area.read.example",
    area: "Area",
    kind: "read",
    description: "Describe the example feature",
    interface_ids: [],
    roles: ["all"],
    flag: "none",
    preconditions: [],
    examples: [],
    invariants: [],
    cleanup: "none",
    confidence: "medium",
    writes_to: null,
    confirmation: null,
    expect_db: null,
    ...overrides,
  };
}

export function buildCatalog(overrides: Partial<Catalog> = {}): Catalog {
  return {
    bundle_id: null,
    bundle_version: null,
    roles: [],
    interfaces: [],
    areas: [],
    ...overrides,
  };
}

export function groupByArea(items: readonly CatalogItem[]): CatalogArea[] {
  const areas = new Map<string, CatalogItem[]>();
  for (const item of items) {
    areas.set(item.area, [...(areas.get(item.area) ?? []), item]);
  }
  return [...areas].map(([name, areaItems]) => ({ name, items: areaItems }));
}
