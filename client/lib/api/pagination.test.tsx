import { QueryClientProvider, useInfiniteQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { components } from "@/lib/api/schema";
import { bearer, mintApiToken } from "@/tests/utils/tokens";
import { createTestQueryClient } from "@/tests/utils/render";
import {
  cursorInfiniteOptions,
  flattenPages,
  sortParamToSorting,
  sortingToSortParam,
  totalOf,
  type CursorPage,
  type CursorPageRequest,
} from "./pagination";

type TargetPage = components["schemas"]["TargetPage"];
type FetchPage = (request: CursorPageRequest) => Promise<CursorPage<string>>;

function wrapperFor(queryClient = createTestQueryClient()) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function page(
  items: string[],
  next_cursor: string | null,
  total: number | null = null,
): CursorPage<string> {
  return { items, next_cursor, total };
}

describe("cursorInfiniteOptions", () => {
  it("starts without a cursor and follows next_cursor until it is null", async () => {
    const pages = new Map<string | null, CursorPage<string>>([
      [null, page(["a", "b"], "c1", 5)],
      ["c1", page(["c", "d"], "c2", 5)],
      ["c2", page(["e"], null, 5)],
    ]);
    const fetchPage = vi.fn(async ({ cursor }: { cursor: string | null }) => {
      const found = pages.get(cursor);
      if (found === undefined) {
        throw new Error(`unexpected cursor ${String(cursor)}`);
      }
      return found;
    });

    const { result } = renderHook(
      () => useInfiniteQuery(cursorInfiniteOptions({ queryKey: ["letters"], fetchPage })),
      { wrapper: wrapperFor() },
    );

    await waitFor(() => expect(result.current.data?.items).toEqual(["a", "b"]));
    expect(result.current.hasNextPage).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0]?.[0]).toMatchObject({ cursor: null });

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() =>
      expect(result.current.data).toEqual({
        items: ["a", "b", "c", "d", "e"],
        total: 5,
        loadedCount: 5,
      }),
    );
    expect(result.current.hasNextPage).toBe(false);
    expect(fetchPage.mock.calls.map(([request]) => request.cursor)).toEqual([null, "c1", "c2"]);
  });

  it("passes an abort signal and keeps total null when the server did not count", async () => {
    const fetchPage = vi.fn<FetchPage>(async () => page(["only"], null));

    const { result } = renderHook(
      () => useInfiniteQuery(cursorInfiniteOptions({ queryKey: ["single"], fetchPage })),
      { wrapper: wrapperFor() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ items: ["only"], total: null, loadedCount: 1 });
    expect(fetchPage.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("refetches from the first page when the query key changes", async () => {
    const fetchPage = vi.fn<FetchPage>(async () => page(["x"], "next"));
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) =>
        useInfiniteQuery(cursorInfiniteOptions({ queryKey: ["targets", { q }], fetchPage })),
      { wrapper: wrapperFor(), initialProps: { q: "" } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);

    rerender({ q: "gracie" });

    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    expect(fetchPage.mock.calls[2]?.[0]).toMatchObject({ cursor: null });
  });

  it("surfaces a failed first page as an error and leaves data undefined", async () => {
    const fetchPage = vi.fn<FetchPage>(async () => {
      throw new Error("boom");
    });
    const { result } = renderHook(
      () =>
        useInfiniteQuery(cursorInfiniteOptions({ queryKey: ["failing"], fetchPage, gcTime: 0 })),
      { wrapper: wrapperFor() },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it("respects enabled=false", () => {
    const fetchPage = vi.fn<FetchPage>(async () => page([], null));
    renderHook(
      () =>
        useInfiniteQuery(cursorInfiniteOptions({ queryKey: ["off"], fetchPage, enabled: false })),
      { wrapper: wrapperFor() },
    );
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("pages the Stage 1 mock targets with include_total", async () => {
    const headers = bearer(await mintApiToken());
    const fetchPage = async ({
      cursor,
      signal,
    }: {
      cursor: string | null;
      signal: AbortSignal;
    }) => {
      const search = new URLSearchParams({ limit: "3", include_total: "true", sort: "name" });
      if (cursor !== null) {
        search.set("cursor", cursor);
      }
      const response = await fetch(`http://localhost:8000/api/v1/targets?${search}`, {
        headers,
        signal,
      });
      return (await response.json()) as TargetPage;
    };

    const { result } = renderHook(
      () => useInfiniteQuery(cursorInfiniteOptions({ queryKey: ["mock-targets"], fetchPage })),
      { wrapper: wrapperFor() },
    );

    await waitFor(() => expect(result.current.data?.items).toHaveLength(3));
    expect(result.current.data?.total).toBe(4);
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(4));
    expect(result.current.data?.items.map((item) => item.name)).toEqual([
      "Billing API",
      "Broken Import",
      "Gracie",
      "Live Shop",
    ]);
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe("flattenPages and totalOf", () => {
  it("handle undefined data", () => {
    expect(flattenPages(undefined)).toEqual([]);
    expect(totalOf(undefined)).toBeNull();
  });

  it("read the total of the last loaded page", () => {
    const data = { pages: [page(["a"], "n", 7), page(["b"], null, 7)], pageParams: [null, "n"] };
    expect(flattenPages(data)).toEqual(["a", "b"]);
    expect(totalOf(data)).toBe(7);
  });
});

describe("sort parameter helpers", () => {
  it("renders a leading minus for descending keys", () => {
    expect(sortingToSortParam([])).toBeUndefined();
    expect(
      sortingToSortParam([
        { id: "created_at", desc: true },
        { id: "name", desc: false },
      ]),
    ).toBe("-created_at,name");
  });

  it("parses the same grammar and drops unknown, empty and duplicate keys", () => {
    expect(sortParamToSorting("-created_at,name")).toEqual([
      { id: "created_at", desc: true },
      { id: "name", desc: false },
    ]);
    expect(sortParamToSorting("name,-name,,slug", ["name", "created_at"])).toEqual([
      { id: "name", desc: false },
    ]);
    expect(sortParamToSorting(null)).toEqual([]);
    expect(sortParamToSorting("  ")).toEqual([]);
  });
});
