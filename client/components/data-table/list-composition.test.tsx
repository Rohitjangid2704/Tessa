import { useInfiniteQuery } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { EmptyState } from "@/components/states/empty-state";
import { ApiError } from "@/lib/api/errors";
import {
  cursorInfiniteOptions,
  sortParamToSorting,
  sortingToSortParam,
} from "@/lib/api/pagination";
import type { components } from "@/lib/api/schema";
import {
  booleanParam,
  createSearchParamsCodec,
  enumListParam,
  sortParam,
  textParam,
} from "@/lib/search-params";
import { useUrlFilters } from "@/lib/url-state";
import { resetLocation, trackHistory } from "@/tests/utils/fake-navigation";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { bearer, mintApiToken } from "@/tests/utils/tokens";
import { createDataTableColumnHelper } from "./features";
import { DataTable } from "./data-table";
import { DataTableFooter } from "./data-table-footer";

vi.mock("next/navigation", async () => await import("@/tests/utils/fake-navigation"));

type TargetSummary = components["schemas"]["TargetSummary"];
type TargetPage = components["schemas"]["TargetPage"];

const APP_KINDS = ["web", "api", "llm_assistant", "worker", "cli"] as const;
const SORT_KEYS = ["name", "created_at"] as const;
const DEFAULT_SORT = "-created_at";
const PAGE_SIZE = 2;

const codec = createSearchParamsCodec(
  {
    q: textParam(),
    app_kind: enumListParam(APP_KINDS),
    include_archived: booleanParam(),
    sort: sortParam(SORT_KEYS),
  },
  { defaults: { include_archived: false, sort: DEFAULT_SORT } },
);

const FIELDS: readonly FilterField<"q" | "app_kind" | "include_archived">[] = [
  { type: "text", key: "q", label: "Search", debounceMs: 20 },
  {
    type: "multi",
    key: "app_kind",
    label: "App kind",
    options: APP_KINDS.map((value) => ({ value, label: value })),
  },
  { type: "toggle", key: "include_archived", label: "Include archived" },
];

const helper = createDataTableColumnHelper<TargetSummary>();
const COLUMNS = helper.columns([
  helper.accessor("name", { header: "Name" }),
  helper.accessor("app_kind", { header: "App kind", enableSorting: false }),
  helper.accessor("completeness_score", {
    header: "Score",
    enableSorting: false,
    cell: (info) => info.getValue() ?? "none",
  }),
  helper.accessor("created_at", { header: "Created", sortDescFirst: true }),
]);

const requests: string[] = [];

async function fetchTargets(search: URLSearchParams, cursor: string | null, signal: AbortSignal) {
  const query = new URLSearchParams(search);
  query.set("limit", String(PAGE_SIZE));
  query.set("include_total", "true");
  if (cursor !== null) {
    query.set("cursor", cursor);
  }
  const url = `http://localhost:8000/api/v1/targets?${query}`;
  requests.push(url);
  const response = await fetch(url, { headers: bearer(await mintApiToken()), signal });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw ApiError.fromResponse(response, body);
  }
  return body as TargetPage;
}

function TargetsList() {
  const { values, setFilters, resetFilters, activeCount } = useUrlFilters(codec);
  const apiQuery = codec.serialize({ ...values, sort: values.sort ?? undefined });
  const query = useInfiniteQuery(
    cursorInfiniteOptions({
      queryKey: ["targets", apiQuery.toString()],
      fetchPage: ({ cursor, signal }) => fetchTargets(apiQuery, cursor, signal),
    }),
  );
  const sorting = sortParamToSorting(values.sort ?? DEFAULT_SORT, SORT_KEYS);

  return (
    <>
      <FilterBar
        label="Filter targets"
        fields={FIELDS}
        values={values}
        onChange={(patch) => setFilters(patch)}
        onReset={() => resetFilters()}
        activeCount={activeCount}
      />
      <DataTable<TargetSummary>
        label="Targets"
        columns={COLUMNS}
        data={query.data?.items}
        getRowId={(row) => row.id}
        isLoading={query.isPending}
        isFetching={query.isFetching}
        error={query.error}
        onRetry={() => void query.refetch()}
        manualSorting
        sorting={sorting}
        onSortingChange={(next) => setFilters({ sort: sortingToSortParam(next) })}
        emptyState={
          <EmptyState title="No targets match" description="Change or clear the filters." />
        }
        footer={
          <DataTableFooter
            noun="target"
            loadedCount={query.data?.loadedCount ?? 0}
            total={query.data?.total}
            hasNextPage={query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
        }
      />
    </>
  );
}

function names(): string[] {
  const table = screen.getByRole("table", { name: "Targets" });
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");
}

let history: ReturnType<typeof trackHistory>;

beforeEach(() => {
  requests.length = 0;
  resetLocation("/targets");
  history = trackHistory();
});

afterEach(() => {
  history.restore();
});

describe("targets list composition", () => {
  it("loads the first page newest first with a counted footer", async () => {
    renderWithProviders(<TargetsList />);

    expect(screen.getByText("Loading targets")).toBeInTheDocument();
    await screen.findByRole("button", { name: "Load more" });
    expect(names()).toEqual(["Broken Import", "Live Shop"]);
    expect(screen.getByText("Showing 2 of 4 targets")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Created/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain("sort=");
  });

  it("loads the next page with the cursor and keeps the earlier rows", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TargetsList />);

    await user.click(await screen.findByRole("button", { name: "Load more" }));

    await screen.findByText("Showing 4 of 4 targets");
    expect(names()).toEqual(["Broken Import", "Live Shop", "Billing API", "Gracie"]);
    expect(requests[1]).toContain("cursor=");
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("sorts on the server through the URL without pushing history", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TargetsList />);
    await screen.findByText("Showing 2 of 4 targets");

    await user.click(screen.getByRole("button", { name: "Sort by Name" }));

    await waitFor(() => expect(names()).toEqual(["Billing API", "Broken Import"]));
    expect(window.location.search).toBe("?sort=name");
    expect(requests.at(-1)).toContain("sort=name");
    expect(requests.at(-1)).not.toContain("cursor=");
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(history.calls.push).toEqual([]);
    expect(history.calls.replace).toEqual(["/targets?sort=name"]);
  });

  it("restores the sorting and filters from a shared URL", async () => {
    resetLocation("/targets?sort=-name&app_kind=api&app_kind=llm_assistant&q=g");

    renderWithProviders(<TargetsList />);

    await screen.findByText("Showing 2 of 2 targets");
    expect(names()).toEqual(["Gracie", "Billing API"]);
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("g");
    expect(screen.getByRole("button", { name: "App kind: 2 selected" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(requests[0]).toContain("sort=-name");
    expect(requests[0]).toContain("q=g");
    expect(requests[0]?.match(/app_kind=/g)).toHaveLength(2);
  });

  it("filters by typing, shows the empty state for no match and recovers on clear", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TargetsList />);
    await screen.findByText("Showing 2 of 4 targets");

    await user.type(screen.getByRole("searchbox", { name: "Search" }), "zzz");

    await screen.findByRole("heading", { name: "No targets match" });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(window.location.search).toBe("?q=zzz");

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    await screen.findByText("Showing 2 of 4 targets");
    expect(window.location.search).toBe("");
    expect(history.calls.push).toEqual([]);
  });

  it("shows an error with a retry that refetches once the API recovers", async () => {
    server.use(
      http.get(
        "*/api/v1/targets",
        () =>
          HttpResponse.json(
            {
              error: {
                code: "internal_error",
                message: "Boom",
                request_id: "req-1234567",
                details: [],
              },
            },
            { status: 500 },
          ),
        { once: true },
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<TargetsList />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/req-1234567/)).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    await screen.findByText("Showing 2 of 4 targets");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
