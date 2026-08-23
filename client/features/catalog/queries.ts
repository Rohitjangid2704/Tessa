import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { CatalogFilterValues } from "./schemas";
import type { AdapterKind, Catalog, CatalogInterface } from "./types";

export const BUNDLE_ID_PARAM = "bundle_id";
export const LARGE_CATALOG_FEATURES = 200;

export interface CatalogRequest {
  targetId: string;
  bundleId: string | null;
  filters: CatalogFilterValues;
}

export function catalogQuery({ targetId, bundleId, filters }: CatalogRequest) {
  return queryOptions({
    queryKey: qk.catalog(targetId, bundleId, filters),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/catalog", {
          params: {
            query: {
              target_id: targetId,
              bundle_id: bundleId ?? undefined,
              q: filters.q,
              area: filters.area,
              kind: filters.kind,
              role: filters.role,
              interface_id: filters.interface_id,
              confidence: filters.confidence,
            },
          },
          signal,
        }),
      ),
  });
}

export function keepCatalogWithinScope(request: Pick<CatalogRequest, "targetId" | "bundleId">) {
  return (
    previous: Catalog | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined,
  ): Catalog | undefined => {
    const sameScope =
      previousQuery?.queryKey[1] === request.targetId &&
      previousQuery.queryKey[2] === request.bundleId;
    return sameScope ? previous : undefined;
  };
}

export function itemCount(catalog: Catalog | undefined): number {
  return catalog?.areas.reduce((total, area) => total + area.items.length, 0) ?? 0;
}

export function areaTotals(catalog: Catalog | undefined): ReadonlyMap<string, number> {
  return new Map((catalog?.areas ?? []).map((area) => [area.name, area.items.length]));
}

export function interfaceKindMap(
  interfaces: readonly CatalogInterface[],
): ReadonlyMap<string, AdapterKind> {
  return new Map(interfaces.map((entry) => [entry.id, entry.kind]));
}

export function hasNoCatalogContent(catalog: Catalog): boolean {
  return (
    catalog.areas.length === 0 && catalog.roles.length === 0 && catalog.interfaces.length === 0
  );
}
