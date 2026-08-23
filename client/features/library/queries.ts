import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { AppKind } from "@/features/targets/types";
import type { LibraryFilterValues } from "./schemas";

export const LIBRARY_PAGE_SIZE = 25;

export interface LibraryListFilters {
  q?: string;
  app_kind?: AppKind[];
  target_id?: string;
}

export function toLibraryListFilters(values: LibraryFilterValues): LibraryListFilters {
  return { q: values.q, app_kind: values.app_kind, target_id: values.target_id };
}

export function libraryListQuery(filters: LibraryListFilters = {}, pageSize = LIBRARY_PAGE_SIZE) {
  return cursorInfiniteOptions({
    queryKey: qk.library.list({ ...filters, limit: pageSize }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/library/bundles", {
          params: { query: { ...filters, cursor, limit: pageSize, include_total: true } },
          signal,
        }),
      ),
  });
}
