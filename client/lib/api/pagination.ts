import { infiniteQueryOptions, type InfiniteData, type QueryKey } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";

export interface CursorPage<Item> {
  items: Item[];
  next_cursor: string | null;
  total: number | null;
}

export interface CursorResult<Item> {
  items: Item[];
  total: number | null;
  loadedCount: number;
}

export interface CursorPageRequest {
  cursor: string | null;
  signal: AbortSignal;
}

export interface CursorInfiniteConfig<Page extends CursorPage<unknown>, Key extends QueryKey> {
  queryKey: Key;
  fetchPage: (request: CursorPageRequest) => Promise<Page>;
  staleTime?: number;
  enabled?: boolean;
  gcTime?: number;
}

type ItemOf<Page extends CursorPage<unknown>> = Page["items"][number];

export function flattenPages<Item>(
  data: InfiniteData<CursorPage<Item>, unknown> | undefined,
): Item[] {
  return data === undefined ? [] : data.pages.flatMap((page) => page.items);
}

export function totalOf<Item>(
  data: InfiniteData<CursorPage<Item>, unknown> | undefined,
): number | null {
  const lastPage = data?.pages.at(-1);
  return lastPage === undefined ? null : lastPage.total;
}

export function selectCursorResult<Item>(
  data: InfiniteData<CursorPage<Item>, unknown>,
): CursorResult<Item> {
  const items = flattenPages(data);
  return { items, total: totalOf(data), loadedCount: items.length };
}

export function cursorInfiniteOptions<Page extends CursorPage<unknown>, Key extends QueryKey>(
  config: CursorInfiniteConfig<Page, Key>,
) {
  const { queryKey, fetchPage, ...behaviour } = config;
  return infiniteQueryOptions({
    queryKey,
    queryFn: ({ pageParam, signal }) => fetchPage({ cursor: pageParam, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: Page) => lastPage.next_cursor,
    select: (data: InfiniteData<Page, string | null>): CursorResult<ItemOf<Page>> =>
      selectCursorResult(data as InfiniteData<CursorPage<ItemOf<Page>>, unknown>),
    ...behaviour,
  });
}

export function sortingToSortParam(sorting: SortingState): string | undefined {
  if (sorting.length === 0) {
    return undefined;
  }
  return sorting.map((entry) => (entry.desc ? `-${entry.id}` : entry.id)).join(",");
}

export function sortParamToSorting(
  param: string | null | undefined,
  allowedKeys?: readonly string[],
): SortingState {
  if (param === null || param === undefined || param.trim() === "") {
    return [];
  }
  const seen = new Set<string>();
  const sorting: SortingState = [];
  for (const part of param.split(",")) {
    const text = part.trim();
    const desc = text.startsWith("-");
    const id = desc ? text.slice(1) : text;
    const allowed = allowedKeys === undefined || allowedKeys.includes(id);
    if (id !== "" && allowed && !seen.has(id)) {
      seen.add(id);
      sorting.push({ id, desc });
    }
  }
  return sorting;
}
