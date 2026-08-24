import { describe, expect, it } from "vitest";
import { renderWithProviders, screen, userEvent, within } from "@/tests/utils/render";
import { CELL_PREVIEW_CHARACTERS, columnsOf, describeCell, RowsTable } from "./rows-table";

const LONG_TEXT = "Prefers early shifts. ".repeat(10).trim();

describe("columnsOf", () => {
  it("lists the union of the keys in first-seen order", () => {
    expect(
      columnsOf([
        { a: 1, b: 2 },
        { b: 3, c: 4 },
        { d: 5, a: 6 },
      ]),
    ).toEqual(["a", "b", "c", "d"]);
    expect(columnsOf([])).toEqual([]);
  });
});

describe("describeCell", () => {
  it("tells a missing key from a null value", () => {
    expect(describeCell({ a: null }, "a")).toMatchObject({ kind: "null", preview: "null" });
    expect(describeCell({ a: null }, "b")).toMatchObject({ kind: "missing" });
  });

  it("stringifies numbers and booleans and keeps short text whole", () => {
    expect(describeCell({ n: 3.5 }, "n")).toMatchObject({ kind: "text", preview: "3.5" });
    expect(describeCell({ b: false }, "b")).toMatchObject({ kind: "text", preview: "false" });
    expect(describeCell({ s: "short" }, "s")).toMatchObject({ preview: "short", isLong: false });
  });

  it("cuts long text and long JSON at the preview length and keeps the full value", () => {
    const text = describeCell({ s: LONG_TEXT }, "s");
    expect(text.isLong).toBe(true);
    expect(text.preview).toHaveLength(CELL_PREVIEW_CHARACTERS + 1);
    expect(text.preview.endsWith("…")).toBe(true);
    expect(text.full).toBe(LONG_TEXT);

    const json = describeCell(
      { o: { list: Array.from({ length: 40 }, (_, index) => index) } },
      "o",
    );
    expect(json.kind).toBe("json");
    expect(json.isLong).toBe(true);
    expect(JSON.parse(json.full)).toEqual({
      list: Array.from({ length: 40 }, (_, index) => index),
    });
    expect(json.full).toContain("\n");
  });

  it("renders nested values as compact JSON", () => {
    expect(describeCell({ o: { a: [1, 2] } }, "o")).toMatchObject({
      kind: "json",
      preview: '{"a":[1,2]}',
      isLong: false,
    });
  });
});

describe("RowsTable", () => {
  it("renders one column per key with row numbers and a labelled focusable region", () => {
    renderWithProviders(
      <RowsTable
        rows={[
          { room: "412", status: "open" },
          { room: "208", status: "open" },
        ]}
        truncated={false}
        label="Rows of open_maintenance"
      />,
    );

    const region = screen.getByRole("region", { name: "Rows of open_maintenance" });
    expect(region).toHaveAttribute("tabindex", "0");
    const table = within(region).getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["#", "room", "status"]);
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(
      within(rows[1] as HTMLElement)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["412", "open"]);
    expect(screen.queryByText(/is cut|more/)).not.toBeInTheDocument();
  });

  it("handles ragged rows: a missing value reads as no value and null reads as null", () => {
    renderWithProviders(
      <RowsTable
        rows={[
          { name: "Maya", contact: { phone: "555-0100" } },
          { name: "Li" },
          { name: "Jordan", contact: null, badge: 4471 },
        ]}
        truncated={false}
      />,
    );

    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "#",
      "name",
      "contact",
      "badge",
    ]);
    const rows = screen.getAllByRole("row");
    expect(within(rows[1] as HTMLElement).getByText('{"phone":"555-0100"}')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getAllByText("no value")).toHaveLength(2);
    expect(within(rows[3] as HTMLElement).getByText("null")).toBeInTheDocument();
    expect(within(rows[3] as HTMLElement).getByText("4471")).toBeInTheDocument();
  });

  it("truncates a long cell and expands and collapses it from a button that reports its state", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RowsTable rows={[{ notes: LONG_TEXT }]} truncated={false} />);

    expect(screen.queryByText(LONG_TEXT)).not.toBeInTheDocument();
    const expand = screen.getByRole("button", { name: /Show more of notes in row 1/ });
    expect(expand).toHaveAttribute("aria-expanded", "false");

    await user.click(expand);
    expect(screen.getByText(LONG_TEXT)).toBeInTheDocument();
    const collapse = screen.getByRole("button", { name: /Show less of notes in row 1/ });
    expect(collapse).toHaveAttribute("aria-expanded", "true");

    await user.click(collapse);
    expect(screen.queryByText(LONG_TEXT)).not.toBeInTheDocument();
  });

  it("expands a long nested value to pretty printed JSON", async () => {
    const user = userEvent.setup();
    const value = { shifts: Array.from({ length: 30 }, (_, index) => `shift-${index}`) };
    renderWithProviders(<RowsTable rows={[{ roster: value }]} truncated={false} />);

    await user.click(screen.getByRole("button", { name: /Show more/ }));

    expect(
      screen.getByText(JSON.stringify(value, null, 2), { normalizer: (text) => text }),
    ).toBeInTheDocument();
  });

  it("shows cell text as text and never as markup", () => {
    const { container } = renderWithProviders(
      <RowsTable
        rows={[{ category: "<img src=x onerror=alert(1)>", name: "Jordan <b>Park</b>" }]}
        truncated={false}
      />,
    );

    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(screen.getByText("Jordan <b>Park</b>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("says when the result is cut and how many rows are shown", () => {
    renderWithProviders(
      <RowsTable rows={Array.from({ length: 200 }, (_, index) => ({ id: index }))} truncated />,
    );

    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("only the first 200 rows are stored and shown");
    expect(screen.getAllByRole("row")).toHaveLength(201);
  });

  it("treats no rows as a valid result and renders no table", () => {
    renderWithProviders(<RowsTable rows={[]} truncated={false} />);

    expect(
      screen.getByText("The query returned no rows. That is still a valid result."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("describes the table to assistive technology in a caption", () => {
    renderWithProviders(<RowsTable rows={[{ a: 1, b: 2 }]} truncated={false} label="Rows" />);

    expect(screen.getByRole("table", { name: "Rows: 1 row, 2 columns" })).toBeInTheDocument();
  });
});
