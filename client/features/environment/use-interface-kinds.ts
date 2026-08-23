import { useQuery } from "@tanstack/react-query";
import { catalogQuery, interfaceKindMap } from "@/features/catalog/queries";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import type { AdapterKind } from "./types";

const NO_INTERFACE_KINDS: ReadonlyMap<string, AdapterKind> = new Map();

export function useInterfaceKinds(targetId: string): ReadonlyMap<string, AdapterKind> {
  const catalog = useQuery({
    ...catalogQuery({ targetId, bundleId: null, filters: {} }),
    meta: INLINE_ERROR_META,
  });
  return catalog.data === undefined ? NO_INTERFACE_KINDS : interfaceKindMap(catalog.data.interfaces);
}
