import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { InvariantInfo, InvariantPack } from "@/lib/api/types";

export const INVARIANT_CATALOG_STALE_MS = 60 * 60 * 1000;

export function invariantCatalogQuery(pack?: InvariantPack) {
  return queryOptions({
    queryKey: qk.invariants.catalog(pack),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/invariants", {
          params: { query: pack === undefined ? {} : { pack: [pack] } },
          signal,
        }),
      ),
    staleTime: INVARIANT_CATALOG_STALE_MS,
    select: (catalog) => catalog.items,
  });
}

export function indexInvariants(
  items: readonly InvariantInfo[],
): ReadonlyMap<string, InvariantInfo> {
  return new Map(items.map((item) => [item.id, item]));
}
