import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { renderWithProviders, screen, userEvent, within } from "@/tests/utils/render";
import { DataTable, DataTableFooter, createDataTableColumnHelper, type SortingState } from ".";

interface Row {
  id: string;
  name: string;
  kind: string;
  score: number;
  created_at: string;
}

const ROWS: Row[] = [
  {
    id: "r1",
    name: "Gracie",
    kind: "llm_assistant",
    score: 92,
    created_at: "2026-09-10T08:00:00.000Z",
  },
  { id: "r2", name: "Billing API", kind: "api", score: 55, created_at: "2026-09-12T08:00:00.000Z" },
  { id: "r3", name: "Live Shop", kind: "web", score: 70, created_at: "2026-09-14T08:00:00.000Z" },
];

const helper = createDataTableColumnHelper<Row>();

const COLUMNS = helper.columns([
  helper.accessor("name", { header: "Name" }),
  helper.accessor("kind", { header: "Kind", enableSorting: false }),
  helper.accessor("score", { header: "Score", sortDescFirst: true, meta: { align: "end" } }),
  helper.accessor("created_at", { header: "Created", sortDescFirst: true }),
  helper.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row }) => <button type="button">Open {row.original.name}</button>,
  }),
]);

function renderTable(props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  return renderWithProviders(
    <DataTable<Row>
      label="Targets"
      columns={COLUMNS}
      data={ROWS}
      getRowId={(row) => row.id}
      getRowProps={(row) => ({ "data-row": row.id })}
      {...props}
    />,
  );
}

function bodyNames(): string[] {
  const table = screen.getByRole("table", { name: "Targets" });
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");
}

describe("DataTable rendering", () => {
  it("renders a named table with column headers, rows and cell content", () => {
    renderTable();

    const table = screen.getByRole("table", { name: "Targets" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Name", "Kind", "Score", "Created", "Actions"]);
    expect(bodyNames()).toEqual(["Gracie", "Billing API", "Live Shop"]);
    expect(within(table).getByText("llm_assistant")).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: "Open Billing API" })).toBeInTheDocument();
    expect(table.querySelector("tr[data-row='r2']")).not.toBeNull();
  });

  it("applies column alignment from the column meta", () => {
    renderTable();

    expect(screen.getByRole("columnheader", { name: /Score/ })).toHaveClass("text-right");
    expect(screen.getByRole("cell", { name: "92" })).toHaveClass("text-right");
    expect(screen.getByRole("columnheader", { name: /Kind/ })).not.toHaveClass("text-right");
  });

  it("updates when the data changes", () => {
    const { rerender } = renderTable();

    rerender(
      <DataTable<Row>
        label="Targets"
        columns={COLUMNS}
        data={ROWS.slice(0, 1)}
        getRowId={(row) => row.id}
      />,
    );

    expect(bodyNames()).toEqual(["Gracie"]);
  });
});

describe("DataTable sorting", () => {
  it("offers a sort button with an accessible name only on sortable columns", () => {
    renderTable();

    expect(screen.getByRole("button", { name: "Sort by Name" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort by Score" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sort by Kind" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "none");
    expect(screen.getByRole("columnheader", { name: /Kind/ })).not.toHaveAttribute("aria-sort");
  });

  it("sorts the loaded rows ascending, then descending, then back to the given order", async () => {
    const user = userEvent.setup();
    renderTable();
    const sortByName = screen.getByRole("button", { name: "Sort by Name" });

    await user.click(sortByName);
    expect(bodyNames()).toEqual(["Billing API", "Gracie", "Live Shop"]);
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );

    await user.click(sortByName);
    expect(bodyNames()).toEqual(["Live Shop", "Gracie", "Billing API"]);
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );

    await user.click(sortByName);
    expect(bodyNames()).toEqual(["Gracie", "Billing API", "Live Shop"]);
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "none");
  });

  it("starts descending for columns that declare sortDescFirst and sorts numbers numerically", async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole("button", { name: "Sort by Score" }));

    expect(bodyNames()).toEqual(["Gracie", "Live Shop", "Billing API"]);
    expect(screen.getByRole("columnheader", { name: /Score/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  it("sorts one column at a time", async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole("button", { name: "Sort by Name" }));
    await user.click(screen.getByRole("button", { name: "Sort by Score" }));

    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "none");
    expect(screen.getByRole("columnheader", { name: /Score/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  it("is operable from the keyboard", async () => {
    const user = userEvent.setup();
    renderTable();

    await user.tab();
    expect(screen.getByRole("button", { name: "Sort by Name" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(bodyNames()).toEqual(["Billing API", "Gracie", "Live Shop"]);
  });

  it("reports the next sorting to a controlled owner and leaves server-sorted data in place", async () => {
    const user = userEvent.setup();
    const onSortingChange = vi.fn<(sorting: SortingState) => void>();
    renderTable({
      manualSorting: true,
      sorting: [{ id: "name", desc: false }],
      onSortingChange,
    });

    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await user.click(screen.getByRole("button", { name: "Sort by Name" }));

    expect(onSortingChange).toHaveBeenCalledWith([{ id: "name", desc: true }]);
    expect(bodyNames()).toEqual(["Gracie", "Billing API", "Live Shop"]);
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("cycles ascending, descending, none for a column that starts ascending", async () => {
    const user = userEvent.setup();
    const onSortingChange = vi.fn<(sorting: SortingState) => void>();
    renderTable({ manualSorting: true, sorting: [{ id: "name", desc: true }], onSortingChange });

    await user.click(screen.getByRole("button", { name: "Sort by Name" }));

    expect(onSortingChange).toHaveBeenCalledWith([]);
  });

  it("cycles descending, ascending, none for a column that declares sortDescFirst", async () => {
    const user = userEvent.setup();
    const onSortingChange = vi.fn<(sorting: SortingState) => void>();
    renderTable({
      manualSorting: true,
      sorting: [{ id: "created_at", desc: true }],
      onSortingChange,
    });

    await user.click(screen.getByRole("button", { name: "Sort by Created" }));

    expect(onSortingChange).toHaveBeenCalledWith([{ id: "created_at", desc: false }]);
  });

  it("sorts client side from a controlled value", () => {
    renderTable({ sorting: [{ id: "score", desc: false }], onSortingChange: vi.fn() });

    expect(bodyNames()).toEqual(["Billing API", "Live Shop", "Gracie"]);
  });
});

describe("DataTable states", () => {
  it("shows the default empty state without a table", () => {
    renderTable({ data: [] });

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No targets yet" })).toBeInTheDocument();
  });

  it("shows a given empty state with its call to action", () => {
    renderTable({
      data: [],
      emptyState: <button type="button">New target</button>,
    });

    expect(screen.getByRole("button", { name: "New target" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No targets yet" })).not.toBeInTheDocument();
  });

  it("shows skeleton rows with the headers while the first page loads", () => {
    renderTable({ data: undefined, isLoading: true, skeletonRows: 4 });

    const table = screen.getByRole("table", { name: "Targets" });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(5);
    expect(screen.getByRole("status")).toHaveTextContent("Loading targets");
    expect(table.querySelectorAll("tbody tr[aria-hidden='true']")).toHaveLength(4);
    expect(table.closest("[data-slot='data-table']")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("heading", { name: "No targets yet" })).not.toBeInTheDocument();
  });

  it("keeps the rows and flags the table busy while refetching", () => {
    renderTable({ isFetching: true });

    expect(bodyNames()).toHaveLength(3);
    expect(
      screen.getByRole("table", { name: "Targets" }).closest("[data-slot='data-table']"),
    ).toHaveAttribute("aria-busy", "true");
  });

  it("shows an alert with the request id and a retry action when the first load fails", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const error = ApiError.network(new TypeError("fetch failed"));
    renderTable({ data: undefined, error, onRetry });

    const alert = screen.getByRole("alert");
    expect(
      within(alert).getByRole("heading", { name: "Could not load targets" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps showing the rows and adds an inline alert when a refresh fails", () => {
    renderTable({ error: new Error("boom"), onRetry: vi.fn() });

    expect(screen.getByRole("alert")).toHaveTextContent("Could not refresh targets");
    expect(bodyNames()).toHaveLength(3);
  });

  it("renders the footer slot under the table", () => {
    renderTable({ footer: <p>footer slot</p> });

    expect(screen.getByText("footer slot")).toBeInTheDocument();
  });
});

describe("DataTableFooter", () => {
  const baseProps = { noun: "target", loadedCount: 3, hasNextPage: true, onLoadMore: vi.fn() };

  it("states how many of the total are shown and offers to load more", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    renderWithProviders(<DataTableFooter {...baseProps} total={7} onLoadMore={onLoadMore} />);

    expect(screen.getByRole("status")).toHaveTextContent("Showing 3 of 7 targets");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("does not claim a total the server did not count", () => {
    renderWithProviders(<DataTableFooter {...baseProps} total={null} />);

    expect(screen.getByRole("status")).toHaveTextContent("Showing the first 3 targets");
  });

  it("disables the button and announces it while the next page loads", () => {
    renderWithProviders(<DataTableFooter {...baseProps} isFetchingNextPage />);

    const button = screen.getByRole("button", { name: "Loading more" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("drops the button on the last page and uses the singular noun", () => {
    renderWithProviders(
      <DataTableFooter {...baseProps} loadedCount={1} total={1} hasNextPage={false} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Showing 1 of 1 target");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders nothing when there is nothing loaded and nothing to load", () => {
    renderWithProviders(<DataTableFooter {...baseProps} loadedCount={0} hasNextPage={false} />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
